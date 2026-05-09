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
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const DATA_BACKUP_QUEUE = "data-backup";

export const POST = apiHandler(async () => {
  const { user: admin } = await requireAdmin();
  annotate({ action: { name: "admin.backups.run" } });

  // pg-boss does not dedupe by payload; without a rate-limit, an
  // impatient admin (or compromised admin session) can stack dozens of
  // identical jobs on the queue. Three runs/min per admin is plenty
  // for ad-hoc snapshots — the weekly cron carries the regular cadence.
  const rl = await checkRateLimit(
    `admin-backups-run:${admin.id}`,
    3,
    60 * 1000,
  );
  if (!rl.allowed) {
    throw new HttpError(429, "Too many backup runs");
  }

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
