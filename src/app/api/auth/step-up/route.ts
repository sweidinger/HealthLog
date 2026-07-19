/**
 * POST /api/auth/step-up
 *
 * Re-prove a factor and receive a single-use, token-bound step-up elevation for
 * one second-factor-management call.
 *
 * This is the whole point of the mechanism, so it is worth being blunt about
 * what it is not: it is NOT a way to turn a token into a stronger credential.
 * Presenting the token gets you as far as this endpoint and no further — the
 * body must carry a fresh proof of the account password or of a primary passkey
 * the device holds. A stolen token can call this all day and mint nothing.
 *
 * Bearer-only (`requireBearerAuth`). A browser cannot reach it even with a valid
 * session, which keeps an ambient cookie credential out of the mint path
 * entirely.
 *
 * Failures are deliberately indistinguishable. A wrong password, an account with
 * no password set, a passkey belonging to someone else, a stale challenge — all
 * return the same 401 with the same prose. The audit row carries the real reason;
 * the wire carries none of it.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireBearerAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  checkAuthSurfaceRateLimit,
  checkRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/auth/password";
import { verifyAuthentication } from "@/lib/auth/passkey";
import {
  mintStepUpElevation,
  STEP_UP_ELEVATION_TTL_SECONDS,
  type StepUpMethod,
} from "@/lib/auth/step-up";
import { stepUpMintSchema } from "@/lib/validations/step-up";

export const dynamic = "force-dynamic";

/**
 * Per-account ceiling. Tight because the password arm runs an Argon2id verify
 * against a user-supplied string — the same 5-per-15-minutes the password-change
 * route uses, for the same reason.
 */
const MINT_LIMIT = 5;
const MINT_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (request: NextRequest) => {
  const auth = await requireBearerAuth();
  const { user } = auth;
  // `requireAuth`'s contract puts the resolved `ApiToken` row id here. It is the
  // binding the minted elevation is tied to.
  const apiTokenId = auth.session.id;
  const ip = getClientIp(request);

  // Two buckets. The per-IP surface bucket collapses to the tight shared anon
  // bucket when the proxy trust chain is broken, so a misconfigured deployment
  // caps a spray rather than opening one.
  const ipRl = await checkAuthSurfaceRateLimit(
    request,
    "auth:step-up",
    20,
    MINT_WINDOW_MS,
  );
  if (!ipRl.allowed) {
    return apiError("Too many attempts. Please try again later.", 429, {
      headers: rateLimitHeaders(ipRl),
    });
  }

  const userRl = await checkRateLimit(
    `auth:step-up:${user.id}`,
    MINT_LIMIT,
    MINT_WINDOW_MS,
  );
  if (!userRl.allowed) {
    await auditLog("auth.stepup.mint.rate_limited", {
      userId: user.id,
      ipAddress: ip,
    });
    annotate({ action: { name: "auth.stepup.mint.rate_limited" } });
    return apiError("Too many attempts. Please wait 15 minutes.", 429, {
      headers: rateLimitHeaders(userRl),
    });
  }

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = stepUpMintSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request", 422);
  }

  let proved = false;
  let method: StepUpMethod = parsed.data.method;
  // Audit-only detail. Never reaches the response — see the file header.
  let failure = "invalid";

  if (parsed.data.method === "password") {
    if (!user.passwordHash) {
      // An SSO-provisioned account has no password to re-prove. Same refusal as
      // a wrong one: the account's credential shape is not a token holder's to
      // enumerate. `/api/auth/step-up/options` is the honest discovery path —
      // it 409s when there is no passkey either.
      failure = "no_password";
    } else {
      proved = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!proved) failure = "bad_password";
    }
  } else {
    method = "passkey";
    // Bind the challenge to the caller BEFORE verifying. `verifyAuthentication`
    // resolves a challenge by id alone; pinning ownership here means a challenge
    // minted for another account cannot be carried into this ceremony.
    const challenge = await prisma.authChallenge.findUnique({
      where: { id: parsed.data.challengeId },
      select: { userId: true },
    });
    if (!challenge || challenge.userId !== user.id) {
      failure = "foreign_challenge";
    } else {
      try {
        const result = await verifyAuthentication(
          parsed.data.challengeId,
          parsed.data.credential,
        );
        // Both halves matter: a verified assertion against SOMEONE ELSE'S
        // passkey proves possession of a factor, just not of this account's.
        proved =
          result.verification.verified && result.passkey.userId === user.id;
        if (!proved) failure = "bad_assertion";
      } catch {
        // A malformed / expired challenge is a failed attempt, not a 500.
        failure = "bad_assertion";
      }
    }
  }

  if (!proved) {
    await auditLog("auth.stepup.mint.failed", {
      userId: user.id,
      ipAddress: ip,
      details: { method: parsed.data.method, reason: failure },
    });
    annotate({
      action: { name: "auth.stepup.mint.failed" },
      meta: { method: parsed.data.method, reason: failure },
    });
    return apiError("Verification failed", 401);
  }

  const { token, expiresAt } = await mintStepUpElevation({
    userId: user.id,
    apiTokenId,
    method,
  });

  await auditLog("auth.stepup.mint.succeeded", {
    userId: user.id,
    ipAddress: ip,
    details: { method },
  });
  annotate({
    action: { name: "auth.stepup.mint.succeeded" },
    meta: { method },
  });

  // `elevation` is the raw secret and is returned exactly once. It is never
  // persisted in plaintext and never logged — no wide-event field carries a
  // response body, and `redactSecrets` holds an `hle_` rule regardless.
  return apiSuccess({
    elevation: token,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: STEP_UP_ELEVATION_TTL_SECONDS,
  });
});
