/**
 * Daily physical purge for soft-deleted document-vault rows.
 *
 * Delete in the vault is undo-able: the DELETE route tombstones
 * (`deletedAt`), the UI's undo toast and the restore endpoint clear the
 * tombstone, and THIS job hard-deletes tombstones older than the 30-day
 * grace window — returning the TOAST space the encrypted blob holds (a
 * tombstoned document keeps counting against the quota until purged, so
 * "deleted" bytes are never invisible backup weight). Staged facts cascade
 * via the FK. Restore-after-purge answers 409 at the API.
 */
import { type Job } from "pg-boss";
import { withBackgroundEvent } from "@/lib/logging/background";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import type { PrismaClient } from "@/generated/prisma/client";

export const DOCUMENT_PURGE_QUEUE = "document-tombstone-purge";
/** Daily at 04:10 Europe/Berlin — after the med-notes backfill tick (04:05). */
export const DOCUMENT_PURGE_CRON = "10 4 * * *";

/** Days a tombstoned document stays restorable before the purge claims it. */
export const DOCUMENT_PURGE_GRACE_DAYS = 30;

const DAY_MS = 86_400_000;

export interface DocumentPurgePayload {
  triggeredAt?: string;
}

/**
 * Hard-delete tombstoned `inbound_documents` rows whose `deletedAt` is older
 * than the grace horizon. Returns the number of rows purged. Rows inside the
 * grace window and live rows are never touched.
 */
export async function purgeExpiredDocumentTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DOCUMENT_PURGE_GRACE_DAYS * DAY_MS);
  const { count } = await prisma.inboundDocument.deleteMany({
    where: { deletedAt: { not: null, lt: cutoff } },
  });
  return count;
}

export async function handleDocumentPurge(jobs: Job<DocumentPurgePayload>[]) {
  void jobs;
  await withBackgroundEvent("job.document_tombstone_purge", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const purged = await purgeExpiredDocumentTombstones(prisma);
      evt.setAction({ name: "documents.vault.purge" });
      evt.addMeta("document_purge_deleted", purged);
    } catch (err) {
      evt.addWarning(`document-tombstone-purge failed: ${err}`);
    }
  });
}
