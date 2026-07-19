/**
 * v1.16.13 — web AI-consent grant (heal endpoint).
 *
 *   POST /api/consent/ai/web
 *     Mints an `ai_full` consent receipt for the calling web user if none
 *     is active, mirroring the iOS master-grant. Idempotent — a user with
 *     an active `ai_full` receipt is a no-op. The web AI-settings surface
 *     calls this on mount (the web equivalent of the iOS shell-mount heal)
 *     so existing web accounts gain a receipt without a re-consent step and
 *     stop hitting the server-managed consent gate's no-key fallback.
 *
 * Revocation stays on `DELETE /api/consent/ai/latest`; this route only
 * grants. The full CRUD (explicit grant with a signed artefact, reader,
 * revoke) lives in `../route.ts` + `../latest/route.ts`.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { checkConsentRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureWebAiConsentReceipt } from "@/lib/consent/web-grant";

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  // The web AI-settings surface calls this on every mount; the bucket is
  // generous enough that the heal path is never throttled in normal use,
  // tight enough to cap a scripted loop.
  const rl = await checkConsentRateLimit(user.id);
  if (!rl.allowed) {
    annotate({
      action: { name: "consent.ai.rate-limited" },
      meta: { userId: user.id, resetAt: rl.resetAt },
    });
    return apiError("Too many consent requests, please wait a moment", 429, {
      headers: rateLimitHeaders(rl),
    });
  }

  const result = await ensureWebAiConsentReceipt(user.id, "heal");

  if (result.minted) {
    // Audit trail parity with the iOS-driven POST /api/consent/ai grant so
    // the legal team can reconstruct web-originated consent. Fire-and-forget.
    auditLog("consent.ai.grant", {
      userId: user.id,
      details: { kind: "ai_full", source: "web", receiptId: result.receipt.id },
    }).catch(() => {});
  }

  annotate({
    action: { name: "consent.ai.web-grant" },
    meta: {
      minted: result.minted,
      ...(result.minted ? { receiptId: result.receipt.id } : {}),
    },
  });

  return apiSuccess({
    minted: result.minted,
    kind: "ai_full" as const,
  });
});
