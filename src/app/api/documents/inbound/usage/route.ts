/**
 * Document vault: storage usage + effective limits for the calling user.
 *
 * The UI reads this before offering an upload (quota bar above 80 % usage,
 * client-side pre-flight against `maxFileBytes`, picker `accept` list from
 * `acceptedExtensions`). `usedBytes` counts every non-purged row — tombstones
 * still hold TOAST bytes until the purge job reclaims them, so "deleted"
 * bytes are never invisible weight and an undo never changes usage.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  DOCUMENT_ACCEPTED_EXTENSIONS,
  resolveDocumentLimits,
} from "@/lib/documents/upload-policy";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import type { DocumentUsageDto } from "@/lib/validations/inbound-documents";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const gate = await requireModuleEnabled(user.id, "inboundDocuments");
  if (!gate.enabled) return gate.response;

  const [limits, rows] = await Promise.all([
    resolveDocumentLimits(user.id),
    prisma.$queryRaw<Array<{ used: bigint }>>`
      SELECT COALESCE(SUM(byte_size), 0)::bigint AS used
      FROM inbound_documents
      WHERE user_id = ${user.id}
    `,
  ]);
  const usedBytes = Number(rows[0]?.used ?? 0);

  annotate({
    action: { name: "documents.vault.usage" },
    meta: { usedBytes, quotaBytes: limits.quotaBytes },
  });

  const payload: DocumentUsageDto = {
    usedBytes,
    quotaBytes: limits.quotaBytes,
    maxFileBytes: limits.maxFileBytes,
    acceptedExtensions: [...DOCUMENT_ACCEPTED_EXTENSIONS],
  };
  return apiSuccess(payload);
});
