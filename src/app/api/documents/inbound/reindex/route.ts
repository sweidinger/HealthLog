/**
 * v1.27.22 (Document vault P2) — trigger the content-search index backfill.
 *
 * Enqueues a per-user job that indexes the caller's not-yet-indexed documents
 * (one provider transcription each, bounded + resumable). Gated on the module,
 * a configured vision provider, and the EXISTING AI consent (the worker
 * re-checks all three). The work runs off-request on pg-boss; this route only
 * enqueues and returns immediately so the vault stays responsive.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { assertDocumentEgressConsent } from "@/lib/ai/consent-guard";
import { auditLog } from "@/lib/auth/audit";
import { enqueueContentIndexBackfill } from "@/lib/jobs/document-content-index-backfill";
import { resolveDocumentVisionProvider } from "@/lib/documents/provider-order";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** A generous per-user ceiling — enqueue is cheap, the worker is the real gate. */
const REINDEX_LIMIT_PER_HOUR = 12;
const REINDEX_WINDOW_MS = 60 * 60 * 1000;

export const POST = apiHandler(async (request) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `documents-reindex:${user.id}`,
    REINDEX_LIMIT_PER_HOUR,
    REINDEX_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests. Try again later.", 429, {
      errorCode: "documents.inbound.rateLimited",
    });
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  // Fail fast when the precondition is not met so the UI gets immediate
  // feedback rather than a silently no-op'd job.
  const { pick } = await resolveDocumentVisionProvider(user.id);
  if (!pick) {
    return apiError("No vision-capable AI provider is configured", 422, {
      errorCode: "documents.inbound.providerUnsupported",
    });
  }
  await assertDocumentEgressConsent({
    userId: user.id,
    providerType: pick.providerType,
    surface: "insights",
  });

  const { enqueued } = await enqueueContentIndexBackfill(user.id);

  await auditLog("documents.inbound.reindex", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { enqueued },
  });
  annotate({
    action: { name: "documents.contentIndex.backfillEnqueue" },
    meta: { enqueued },
  });

  return apiSuccess({ enqueued });
});
