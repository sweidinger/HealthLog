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

  const [limits, rows, linkRows] = await Promise.all([
    resolveDocumentLimits(user.id),
    prisma.$queryRaw<Array<{ used: bigint }>>`
      SELECT COALESCE(SUM(byte_size), 0)::bigint AS used
      FROM inbound_documents
      WHERE user_id = ${user.id}
    `,
    // Episodes that carry at least one LIVE document link — the filter
    // bar's condition chips. Sourced here (not from the loaded corpus) so
    // a chip exists even when its documents sit pages deep in the
    // timeline; one indexed grouped query, no blobs.
    prisma.documentConditionLink.findMany({
      where: { userId: user.id, document: { deletedAt: null } },
      select: { episodeId: true, episode: { select: { label: true } } },
      distinct: ["episodeId"],
      orderBy: { episodeId: "asc" },
    }),
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
    linkedEpisodes: linkRows.map((row) => ({
      episodeId: row.episodeId,
      name: row.episode.label,
    })),
  };
  return apiSuccess(payload);
});
