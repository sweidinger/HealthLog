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
import {
  OIDC_MFA_COOKIE,
  OIDC_MFA_COOKIE_PATH,
  OIDC_MFA_TTL_MS,
  OIDC_STATE_COOKIE,
} from "@/lib/auth/oidc-cookie";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";
import { syncMfaEnrollCookie } from "@/lib/auth/mfa-enrollment";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";
import { resolveServerDefaultTimezone } from "@/lib/tz/resolver";

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

    // (1) Durable identity match — the (issuer, sub) pair stamped on a
    // previous login, link, or provision. Email is deliberately NOT
    // consulted here: after the stamp it is a display field, so an
    // IdP-side email change can refresh it below but can never re-point
    // the login at a different account.
    let user = await prisma.user.findFirst({
      where: { oidcIssuer: metadata.issuer, oidcSub: identity.sub },
    });

    if (user) {
      // Refresh the display email only — and only from a claim the IdP
      // explicitly marks verified. Skipped when another account already
      // holds the address (`email` is unique); the login itself proceeds
      // either way, keyed by (issuer, sub).
      const displayEmail = email ? email.toLowerCase() : null;
      if (
        displayEmail &&
        emailVerified === true &&
        user.email?.toLowerCase() !== displayEmail
      ) {
        const emailTaken = await prisma.user.findFirst({
          where: {
            email: { equals: displayEmail, mode: "insensitive" },
            NOT: { id: user.id },
          },
          select: { id: true },
        });
        if (!emailTaken) {
          user = await prisma.user.update({
            where: { id: user.id },
            data: { email: displayEmail },
          });
        }
      }
    } else {
      // No stamped identity yet — both remaining paths (link-once,
      // provision) bind this (issuer, sub) to an account keyed by email,
      // so the claim must be explicitly `email_verified: true`. An ABSENT
      // claim is a reject, not a benefit of the doubt: an IdP that does
      // not assert verification cannot anchor a link that later gates a
      // health record.
      if (!email) {
        annotate({ meta: { reason: "no_email" } });
        return errorRedirect(req, "oidc_no_email");
      }
      if (emailVerified !== true) {
        annotate({ meta: { reason: "email_unverified" } });
        return errorRedirect(req, "oidc_email_unverified");
      }

      const byEmail = await prisma.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
      });

      if (byEmail) {
        // (2) Link ONCE. An account already pinned to a different IdP
        // identity is never silently re-bound — a rebind would let a
        // second IdP identity that acquires the same email capture the
        // account. Audited so the operator can see the collision.
        if (byEmail.oidcIssuer !== null || byEmail.oidcSub !== null) {
          await auditLog("auth.oidc.link_conflict", {
            userId: byEmail.id,
            ipAddress: ip,
          });
          annotate({ meta: { reason: "identity_conflict" } });
          return errorRedirect(req, "oidc_identity_conflict");
        }
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { oidcIssuer: metadata.issuer, oidcSub: identity.sub },
        });
        await auditLog("auth.oidc.linked", {
          userId: user.id,
          ipAddress: ip,
        });
      } else {
        // (3) Provision.
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
            email: email.toLowerCase(),
            username,
            passwordHash: null,
            role: userCount === 0 ? "ADMIN" : "USER",
            // Same server-default resolution the register route uses — an
            // SSO-provisioned account has no registration form to carry the
            // browser-detected timezone.
            timezone: await resolveServerDefaultTimezone(),
            oidcIssuer: metadata.issuer,
            oidcSub: identity.sub,
          },
        });

        await auditLog("auth.oidc.provisioned", {
          userId: user.id,
          ipAddress: ip,
        });
      }
    }

    // Native second factor. OIDC is a DELEGATED factor: it proves the IdP
    // authenticated someone, but it never substitutes for this app's own
    // second factor. An account with a confirmed TOTP secret or a
    // registered security key gets the same MFA challenge step password
    // login gets — no session is minted here; the single-use ticket rides
    // the handoff cookie to the login page, which renders the same
    // challenge UI and completes at `/api/auth/mfa/verify`. (The
    // trusted-device skip cannot apply on this path: its cookie is
    // SameSite=Strict, which the browser withholds on an IdP-initiated
    // redirect chain.)
    const hasTotp = Boolean(user.totpConfirmedAt);
    const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
      where: { userId: user.id },
    });
    const hasWebauthn = webauthnKeyCount > 0;

    if (hasTotp || hasWebauthn) {
      const challenge = await createMfaChallenge(user.id, "login");
      const methods: ("totp" | "recovery" | "webauthn")[] = [];
      if (hasTotp) methods.push("totp", "recovery");
      if (hasWebauthn) methods.push("webauthn");
      await auditLog("auth.mfa.challenge", {
        userId: user.id,
        ipAddress: ip,
        details: { source: "login.oidc" },
      });
      annotate({
        action: { name: "auth.mfa.challenge" },
        meta: { mfa_required: true },
      });
      const loginUrl = new URL(LOGIN_ERROR_URL, req.url);
      if (stored.next !== "/") {
        loginUrl.searchParams.set("next", stored.next);
      }
      const response = NextResponse.redirect(loginUrl);
      response.cookies.delete(OIDC_STATE_COOKIE);
      response.cookies.set(
        OIDC_MFA_COOKIE,
        JSON.stringify({ ticket: challenge.ticket, methods }),
        {
          // Not httpOnly by design — see the constant's doc comment.
          httpOnly: false,
          secure: shouldEmitSecureCookie(),
          sameSite: "lax",
          maxAge: Math.floor(OIDC_MFA_TTL_MS / 1000),
          path: OIDC_MFA_COOKIE_PATH,
        },
      );
      return response;
    }

    const ua = req.headers.get("user-agent");

    // v1.23 parity with password login — the admin-enforced-MFA hint cookie
    // sends a single-factor account into forced enrollment after sign-in.
    await syncMfaEnrollCookie(user.id, {
      totpConfirmedAt: user.totpConfirmedAt,
      mfaEnforced: user.mfaEnforced,
    });

    // The 5th argument stays null: OIDC is a delegated factor, so an SSO
    // session must never satisfy `requireFreshMfa` step-up (MFA disable,
    // encryption-key rotation, encrypted export, account deletion) — the
    // same treatment a trusted-device login gets.
    await createSession(
      user.id,
      user.onboardingCompletedAt === null,
      ip,
      ua,
      null,
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
