import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate, getEvent } from "@/lib/logging/context";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { createSession } from "@/lib/auth/session";
import { recordSignInDevice } from "@/lib/auth/login-alert";
import {
  deriveUniqueUsername,
  discoverOidcMetadata,
  exchangeCodeForTokens,
  fetchUserinfoEmail,
  getOidcConfig,
  getOidcRedirectUri,
  verifyIdToken,
} from "@/lib/auth/oidc";
import { OIDC_STATE_COOKIE } from "@/lib/auth/oidc-cookie";

const LOGIN_ERROR_URL = "/auth/login";

function errorRedirect(req: NextRequest, reason: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(`${LOGIN_ERROR_URL}?error=${reason}`, req.url),
  );
  response.cookies.delete(OIDC_STATE_COOKIE);
  return response;
}

interface StoredOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
}

function isStoredOidcState(value: unknown): value is StoredOidcState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).state === "string" &&
    typeof (value as Record<string, unknown>).nonce === "string" &&
    typeof (value as Record<string, unknown>).codeVerifier === "string" &&
    typeof (value as Record<string, unknown>).next === "string"
  );
}

/**
 * OIDC callback. Must work with NO existing session — this route
 * authenticates the user in the first place, unlike the per-account
 * integration callbacks (Withings/Polar/etc.) which all require
 * `requireAuth()`. Every failure branch redirects to `/auth/login?error=...`
 * (never JSON — this is a top-level browser navigation) and deletes the
 * single-use state cookie, mirroring `src/app/api/withings/callback/route.ts`.
 */
export const GET = apiHandler(async (req: NextRequest) => {
  annotate({ action: { name: "auth.oidc.callback" } });

  const config = getOidcConfig();
  if (!config) return errorRedirect(req, "oidc_disabled");

  const rl = await checkAuthSurfaceRateLimit(
    req,
    "auth:oidc:callback",
    20,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) return errorRedirect(req, "oidc_rate_limited");

  const { searchParams } = req.nextUrl;
  const idpError = searchParams.get("error");
  if (idpError) {
    annotate({ meta: { reason: "idp_denied", idpError } });
    return errorRedirect(req, "oidc_denied");
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) return errorRedirect(req, "oidc_state");

  const rawCookie = req.cookies.get(OIDC_STATE_COOKIE)?.value;
  let stored: StoredOidcState | null = null;
  if (rawCookie) {
    try {
      const parsed: unknown = JSON.parse(decrypt(rawCookie));
      if (isStoredOidcState(parsed)) stored = parsed;
    } catch {
      stored = null;
    }
  }
  if (!stored) return errorRedirect(req, "oidc_state");

  // CSRF check — timing-safe, byte-for-byte, mirroring the Withings callback.
  if (
    state.length !== stored.state.length ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(stored.state))
  ) {
    annotate({ meta: { reason: "csrf" } });
    return errorRedirect(req, "oidc_state");
  }

  try {
    const metadata = await discoverOidcMetadata(config);
    const redirectUri = getOidcRedirectUri();

    const tokens = await exchangeCodeForTokens({
      metadata,
      config,
      code,
      codeVerifier: stored.codeVerifier,
      redirectUri,
    });
    if (!tokens.id_token) return errorRedirect(req, "oidc_failed");

    const identity = await verifyIdToken({
      metadata,
      config,
      idToken: tokens.id_token,
      nonce: stored.nonce,
    });

    let email = identity.email;
    let emailVerified = identity.emailVerified;
    if (!email && tokens.access_token) {
      const userinfo = await fetchUserinfoEmail({
        metadata,
        accessToken: tokens.access_token,
      });
      email = userinfo.email;
      emailVerified = userinfo.emailVerified;
    }

    // Accept a verified email, or one with no `email_verified` claim at
    // all (some providers never send it) — but never one explicitly
    // marked unverified.
    if (!email || emailVerified === false) {
      annotate({ meta: { reason: "no_verified_email" } });
      return errorRedirect(req, "oidc_no_email");
    }

    let user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });

    if (!user) {
      const userCount = await prisma.user.count();
      let registrationEnabled = true;
      try {
        const settings = await prisma.appSettings.findUnique({
          where: { id: "singleton" },
        });
        if (settings && !settings.registrationEnabled && userCount > 0) {
          registrationEnabled = false;
        }
      } catch {
        // Table may not exist yet; allow provisioning (matches register/route.ts).
      }
      if (!registrationEnabled) {
        annotate({ meta: { reason: "registration_disabled" } });
        return errorRedirect(req, "oidc_registration_disabled");
      }

      const username = await deriveUniqueUsername(email, (candidate) =>
        prisma.user
          .findUnique({ where: { username: candidate } })
          .then((u: unknown) => u !== null),
      );

      user = await prisma.user.create({
        data: {
          email,
          username,
          passwordHash: null,
          role: userCount === 0 ? "ADMIN" : "USER",
        },
      });

      await auditLog("auth.oidc.provisioned", {
        userId: user.id,
        ipAddress: ip,
      });
    }

    const ua = req.headers.get("user-agent");
    // The IdP already performed its own authentication — OIDC login
    // satisfies HealthLog's own MFA step-up, the same treatment passkey
    // login gives its own factor.
    await createSession(
      user.id,
      user.onboardingCompletedAt === null,
      ip,
      ua,
      new Date(),
    );

    void recordSignInDevice({ userId: user.id, ip, userAgent: ua });

    await auditLog("auth.oidc.login", { userId: user.id, ipAddress: ip });

    const response = NextResponse.redirect(new URL(stored.next, req.url));
    response.cookies.delete(OIDC_STATE_COOKIE);
    return response;
  } catch (err) {
    getEvent()?.setError(err);
    annotate({ meta: { reason: "exchange_or_verify_failed" } });
    return errorRedirect(req, "oidc_failed");
  }
});
