/**
 * v1.17.0 — shared poll-cohort job-handler factory.
 *
 * The Polar, Oura and Nightscout sync handlers were byte-identical wrappers
 * differing only in three things: the wide-event task name, the cohort
 * discovery query (which credential column marks a connected user), and the
 * per-user `syncUser*` callback. This factory lifts the shared control flow —
 * targets from the job payloads or, on a `userId`-less cron tick, from the
 * cohort query; a sequential pass with per-user error isolation; and the
 * `users_synced` / `total` / `measurements_imported` background result.
 *
 * Each provider file collapses to a small config calling `makePollCohortHandler`.
 * The queue name, cron schedule, and boss.work registration stay in
 * reminder-worker.ts.
 *
 * Fitbit is intentionally NOT built on this factory: it fans the cohort out
 * with bounded concurrency via `runFitbitPollCohort`, a different control flow
 * from this sequential pass.
 */
import { type Job } from "pg-boss";

import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { getWorkerPrisma } from "./shared";

/** Every poll-cohort handler accepts an optional single-user payload. */
export interface PollCohortPayload {
  userId?: string;
}

export interface PollCohortConfig {
  /** Wide-event task name, e.g. `job.polar_sync`. */
  taskName: string;
  /**
   * Cohort discovery for a `userId`-less cron tick: returns every connected
   * user's id. Receives the worker Prisma client.
   */
  findCohort: (prisma: ReturnType<typeof getWorkerPrisma>) => Promise<string[]>;
  /** Sync one user; returns the count of measurements imported. */
  syncUser: (userId: string) => Promise<number>;
}

/**
 * Build a pg-boss batch handler for a poll-only integration. The returned
 * handler resolves its targets from the batch payloads (single-user enqueue) or
 * the cohort query (cron tick), then re-syncs each sequentially with per-user
 * error isolation so one revoked grant / outage never starves the cohort.
 */
export function makePollCohortHandler({
  taskName,
  findCohort,
  syncUser,
}: PollCohortConfig) {
  return async function handlePollCohort(jobs: Job<PollCohortPayload>[]) {
    await withBackgroundEvent(taskName, async (evt) => {
      const prisma = getWorkerPrisma();
      try {
        const targets: Array<{ userId: string }> = [];
        for (const job of jobs) {
          if (job.data?.userId) targets.push({ userId: job.data.userId });
        }
        if (targets.length === 0) {
          const ids = await findCohort(prisma);
          targets.push(...ids.map((userId) => ({ userId })));
        }
        if (targets.length === 0) return;

        let usersSynced = 0;
        let measurementsImported = 0;
        for (const { userId } of targets) {
          try {
            measurementsImported += await syncUser(userId);
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
  };
}
