/**
 * WHOOP hourly resource syncs (recovery / sleep / workout / cycle) sharing one cohort runner.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { syncUserRecovery } from "@/lib/whoop/sync-recovery";
import { syncUserSleep as syncWhoopSleep } from "@/lib/whoop/sync-sleep";
import { syncUserCycle } from "@/lib/whoop/sync-cycle";
import { syncUserWorkout } from "@/lib/whoop/sync-workout";
import { getWorkerPrisma } from "./shared";

/**
 * v1.11.0 — WHOOP per-resource sync payload. Two enqueue paths feed each
 * WHOOP sync queue:
 *
 *   1. Webhook (`recovery.updated` / `sleep.updated` / `workout.updated`) —
 *      payload carries `userId`, the handler syncs that one user.
 *   2. Cron — payload has no `userId`; the handler iterates every WHOOP
 *      connection and re-syncs each, catching dropped webhook deliveries.
 *      Cycle has no webhook, so its cron is the sole driver.
 */
export interface WhoopSyncPayload {
  userId?: string;
}

/**
 * Shared driver for the per-resource WHOOP sync handlers. Resolves the target
 * set (per-user from the webhook payload, or every connection on the cron
 * tick) and runs `syncFn` per user. One user's parked-at-reauth state never
 * starves the rest of the cohort on the cron path.
 */
export async function runWhoopResourceSync(
  taskName: string,
  jobs: Job<WhoopSyncPayload>[],
  syncFn: (userId: string) => Promise<number>,
): Promise<void> {
  await withBackgroundEvent(taskName, async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        const connections = await prisma.whoopConnection.findMany({
          select: { userId: true },
        });
        targets.push(...connections);
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          measurementsImported += await syncFn(userId);
          usersSynced++;
        } catch (err) {
          evt.addWarning(`${taskName} failed for user ${userId}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: taskName,
        result: {
          users_synced: usersSynced,
          total: targets.length,
          measurements_imported: measurementsImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

export function handleWhoopRecoverySync(jobs: Job<WhoopSyncPayload>[]) {
  return runWhoopResourceSync(
    "job.whoop_recovery_sync",
    jobs,
    syncUserRecovery,
  );
}

export function handleWhoopSleepSync(jobs: Job<WhoopSyncPayload>[]) {
  return runWhoopResourceSync("job.whoop_sleep_sync", jobs, syncWhoopSleep);
}

export function handleWhoopWorkoutSync(jobs: Job<WhoopSyncPayload>[]) {
  return runWhoopResourceSync("job.whoop_workout_sync", jobs, syncUserWorkout);
}

export function handleWhoopCycleSync(jobs: Job<WhoopSyncPayload>[]) {
  return runWhoopResourceSync("job.whoop_cycle_sync", jobs, syncUserCycle);
}
