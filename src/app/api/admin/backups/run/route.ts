/**
 * POST /api/admin/backups/run — enqueue a manual data-backup pg-boss job.
 *
 * The pg-boss `data-backup` queue is also driven by a weekly cron in the
 * worker (Sundays 03:00 Europe/Berlin); this route lets an admin force a
 * snapshot now. Returns the boss job id so the UI can show feedback.
 *
 * If the worker isn't running (no global boss instance) the route returns
 * 503 — the caller can then route the user to the system-status page.
 */
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

export const dynamic = "force-dynamic";

const DATA_BACKUP_QUEUE = "data-backup";

export const POST = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.backups.run" } });

  const boss = getGlobalBoss();
  if (!boss) {
    // 503 instead of 500 — the request is well-formed; the worker just
    // isn't reachable from this process. Same response shape as other
    // worker-required endpoints.
    throw new HttpError(503, "Background worker is not running");
  }

  const jobId = await boss.send(DATA_BACKUP_QUEUE, {
    triggeredAt: new Date().toISOString(),
  });

  annotate({ meta: { job_id: jobId ?? null } });

  return apiSuccess({
    jobId,
    queue: DATA_BACKUP_QUEUE,
  });
});
