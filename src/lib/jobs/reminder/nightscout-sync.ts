/**
 * Nightscout hourly poll-cohort sync handler (v1.17.0).
 *
 * Poll-only: Nightscout has no outbound webhook to HealthLog, so the single
 * hourly cron tick carries no `userId` and the handler iterates every user with
 * a configured instance, re-syncing each via `syncUserNightscout`. One user's
 * unreachable instance never starves the rest of the cohort — a per-user error
 * is warned and the pass continues.
 *
 * Extracted from reminder-worker.ts, which owns the queue name, cron schedule,
 * and boss.work registration.
 */
import { type Job } from "pg-boss";

import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { syncUserNightscout } from "@/lib/nightscout/sync";
import { getWorkerPrisma } from "./shared";

export interface NightscoutSyncPayload {
  userId?: string;
}

export async function handleNightscoutSync(jobs: Job<NightscoutSyncPayload>[]) {
  await withBackgroundEvent("job.nightscout_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        // Cron tick — re-walk every configured instance. The URL column is
        // the connect marker (a public instance stores no token).
        const users = await prisma.user.findMany({
          where: { nightscoutUrlEncrypted: { not: null } },
          select: { id: true },
        });
        targets.push(...users.map((u) => ({ userId: u.id })));
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          measurementsImported += await syncUserNightscout(userId);
          usersSynced++;
        } catch (err) {
          evt.addWarning(
            `job.nightscout_sync failed for user ${userId}: ${err}`,
          );
        }
      }

      evt.setBackground({
        task_name: "job.nightscout_sync",
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
