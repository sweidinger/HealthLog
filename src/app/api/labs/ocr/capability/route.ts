/**
 * v1.18.9 — GET /api/labs/ocr/capability
 *
 * Cheap probe (no provider call) the Labs UI uses to decide whether to show
 * the "Scan a report" affordance. Returns `{ available, reason, pdfSupported }`
 * for the calling user's configured AI provider. The surface stays dark for
 * codex-only / text-only-model users.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { resolveOcrCapability } from "@/lib/labs/ocr-capability";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const capability = await resolveOcrCapability(user.id);

  annotate({
    action: { name: "labs.ocr.capability" },
    meta: {
      available: capability.available,
      reason: capability.reason,
      pdfSupported: capability.pdfSupported,
    },
  });

  return apiSuccess(capability);
});
