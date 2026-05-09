/**
 * GET /api/admin/backups — admin-only listing of `DataBackup` rows.
 *
 * Returns one row per (userId, type) pair. The `data` payload is NOT
 * shipped — only metadata (id, userId, username, type, size in bytes,
 * createdAt). The encrypted blob remains server-side; admins can trigger
 * a re-snapshot but not download another user's payload from the UI.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export interface BackupRow {
  id: string;
  userId: string;
  username: string;
  type: string;
  /**
   * Size of the encrypted blob in bytes — useful for capacity planning.
   * The blob itself is never returned.
   */
  sizeBytes: number;
  createdAt: string;
}

export interface BackupsList {
  rows: BackupRow[];
  /**
   * Soft retention hint — the worker is configured for weekly backups
   * (see `DATA_BACKUP_CRON` in `src/lib/jobs/reminder-worker.ts`), and
   * the model upserts in-place per (userId, type), so each user has
   * exactly one current snapshot. The frontend uses this to label the
   * grid; no server-side enforcement.
   */
  retentionDays: number;
}

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.backups.list" } });

  // Pull metadata only — `data` would balloon the response and reveal
  // ciphertext we don't need on the listing page.
  const backups = await prisma.dataBackup.findMany({
    include: { user: { select: { id: true, username: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows: BackupRow[] = backups.map((b) => ({
    id: b.id,
    userId: b.userId,
    username: b.user.username,
    type: b.type,
    sizeBytes: Buffer.byteLength(b.data, "utf8"),
    createdAt: b.createdAt.toISOString(),
  }));

  const payload: BackupsList = {
    rows,
    // Mirrors the value surfaced by `/api/admin/status-overview` so the
    // backups page and the status card grid agree.
    retentionDays: 90,
  };

  return apiSuccess(payload);
});
