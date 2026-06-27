/**
 * POST /api/auth/me/mfa/disable
 *
 * Tear down the second factor. Double-gated:
 *  1. `requireFreshMfa` — a cookie session that completed a second factor
 *     within the step-up window (Bearer can never satisfy this).
 *  2. A current TOTP or recovery code in the body — proves live possession at
 *     the moment of the destructive action, not just a stale fresh-session.
 *
 * On success it clears `totpSecretEncrypted` / `totpConfirmedAt` /
 * `totpLastStep` and deletes every recovery code in one transaction.
 */
import {
  apiHandler,
  requireFreshMfa,
  HttpError,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { destroyOtherSessions } from "@/lib/auth/session";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";
import { mfaDisableSchema } from "@/lib/validations/mfa";

export const dynamic = "force-dynamic";

const DISABLE_RATE_LIMIT = 5;
const DISABLE_WINDOW_MS = 15 * 60 * 1000;

export const POST = apiHandler(async (req: Request) => {
  // Step-up gate first — throws StepUpRequiredError (401 + errorCode) if the
  // session is not freshly second-factor-verified.
  const { user, session } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);

  const rl = await checkRateLimit(
    `mfa:disable:${user.id}`,
    DISABLE_RATE_LIMIT,
    DISABLE_WINDOW_MS,
  );
  if (!rl.allowed) {
    const res = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      res.headers.set(k, v);
    }
    return res;
  }

  const { data: body, error: jsonError } = await safeJson(req, {
    maxBytes: 4096,
  });
  if (jsonError) {
    throw new HttpError(400, "Invalid JSON body");
  }
  const parsed = mfaDisableSchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid request", 422);
  }

  const factor = await verifyMfaFactor(
    user,
    parsed.data.method,
    parsed.data.code,
  );
  if (!factor.ok) {
    await auditLog("auth.mfa.failed", {
      userId: user.id,
      ipAddress: getClientIp(req),
      details: {
        stage: "disable",
        method: parsed.data.method,
        replay: factor.replay,
      },
    });
    annotate({ action: { name: "auth.mfa.disable.invalid_factor" } });
    throw new HttpError(401, "Invalid code");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        totpSecretEncrypted: null,
        totpConfirmedAt: null,
        totpLastStep: null,
      },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
  });

  // v1.23 (M-review L3) — removing the second factor is a security-state
  // change: drop every OTHER web session, every native refresh token, and
  // every "remember this device" trusted device (all handled by
  // destroyOtherSessions), keeping only the caller's current session. A stale
  // session or a trusted-device cookie must not survive the factor's removal.
  await destroyOtherSessions(user.id, session.id);

  await auditLog("auth.mfa.disabled", {
    userId: user.id,
    ipAddress: getClientIp(req),
    details: { factor: parsed.data.method },
  });
  annotate({ action: { name: "auth.mfa.disabled" } });

  return apiSuccess({ enabled: false });
});
