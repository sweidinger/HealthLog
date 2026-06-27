import { prisma } from "@/lib/db";
import { loginPasswordSchema } from "@/lib/validations/auth";
import { verifyPassword } from "@/lib/auth/password";
import { auditLog } from "@/lib/auth/audit";
import { hashToken } from "@/lib/auth/hmac";
import { apiError, safeJson } from "@/lib/api-response";
import { checkAuthSurfaceRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { finishLogin } from "@/lib/auth/login-response";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.4.43 W13 M-4 — `checkAuthSurfaceRateLimit` swaps to a tighter
  // global bucket when the trust chain is misconfigured; otherwise it
  // is byte-equivalent to the previous per-IP `auth:login:{ip}` key.
  const rl = await checkAuthSurfaceRateLimit(
    request,
    "auth:login",
    5,
    15 * 60 * 1000,
  );
  const ip = rl.ip ?? "unknown";
  if (!rl.allowed) {
    return NextResponse.json(
      {
        data: null,
        error: "Too many login attempts. Please try again later.",
      },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  await ensureDbCompatibility();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = loginPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return apiError("Invalid credentials", 422);
  }

  const { email, password } = parsed.data;
  const identifier = email.trim();
  // HMAC of the typed identifier — keyed by `API_TOKEN_HMAC_KEY`,
  // mirrors the `/api/auth/check-user` pattern. The raw identifier
  // stays out of the audit row (H-1 contract); the hash gives a
  // future spray-detector a forensic anchor it can correlate across
  // IPs without having to look up users by email.
  const identifierHash = hashToken(identifier);

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: identifier, mode: "insensitive" } },
        { username: { equals: identifier, mode: "insensitive" } },
      ],
    },
  });

  if (!user || !user.passwordHash) {
    // v1.4.43 W3-SECURITY (H-1): never write the typed identifier into
    // the audit row — `reason` already tells the operator what
    // happened, and PII must not land in operator artefacts. The
    // HMAC anchor below is one-way — recoverable only with the HMAC
    // key (operator secret), used purely to group same-identifier
    // attempts across IPs.
    await auditLog("auth.login.failed", {
      ipAddress: ip,
      details: { reason: "user_not_found_or_no_password", identifierHash },
    });
    return apiError("Invalid credentials", 401);
  }

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await auditLog("auth.login.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { reason: "invalid_password", identifierHash },
    });
    return apiError("Invalid credentials", 401);
  }

  const ua = request.headers.get("user-agent");

  await auditLog("auth.login.password", {
    userId: user.id,
    ipAddress: ip,
  });

  // v1.23 — second-factor gate. The password is correct, but an account with
  // a confirmed second factor (a TOTP secret and/or a registered WebAuthn
  // security key) is NOT yet authenticated: no `Session` row and no token
  // bundle is minted here. Instead a single-use, ~5-minute MFA ticket is
  // returned (the partial state lives in the ticket, never in a half-built
  // session) and the client completes the login at `/api/auth/mfa/verify`
  // (TOTP / recovery) or `/api/auth/mfa/webauthn/verify` (security key).
  //
  // Enumeration note: `meta.mfaRequired` is only ever returned AFTER a valid
  // password, and the invalid-credentials response above is identical
  // regardless of MFA state — an attacker without the password cannot learn
  // whether an account has MFA.
  const hasTotp = Boolean(user.totpConfirmedAt);
  const webauthnKeyCount = await prisma.webauthnMfaCredential.count({
    where: { userId: user.id },
  });
  const hasWebauthn = webauthnKeyCount > 0;

  if (hasTotp || hasWebauthn) {
    const challenge = await createMfaChallenge(user.id, "login");
    // Recovery codes are only ever issued alongside TOTP enrollment, so the
    // recovery method is offered exactly when TOTP is active.
    const methods: ("totp" | "recovery" | "webauthn")[] = [];
    if (hasTotp) methods.push("totp", "recovery");
    if (hasWebauthn) methods.push("webauthn");
    await auditLog("auth.mfa.challenge", {
      userId: user.id,
      ipAddress: ip,
      details: { source: "login.password" },
    });
    annotate({
      action: { name: "auth.mfa.challenge" },
      meta: { mfa_required: true },
    });
    return NextResponse.json(
      {
        data: null,
        error: null,
        meta: {
          mfaRequired: true,
          mfaTicket: challenge.ticket,
          methods,
        },
      },
      { status: 200 },
    );
  }

  annotate({ action: { name: "auth.login.password" } });

  // No second factor — issue the session/token exactly as before.
  return finishLogin({
    user,
    request,
    ip,
    userAgent: ua,
    source: "login.password",
  });
});
