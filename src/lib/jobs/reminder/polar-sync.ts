/**
 * v1.17.0 (F4) — Polar poll-cohort sync handler.
 *
 * Poll-only: Polar AccessLink has a webhook, but HealthLog runs the simpler
 * poll model (matching Nightscout). One hourly cron tick carries no `userId`
 * and the handler iterates every user with a stored Polar token, re-syncing
 * each via `syncUserPolar`. One user's revoked grant / outage is warned and the
 * pass continues.
 *
 * The queue name, cron schedule, and boss.work registration live in
 * reminder-worker.ts.
 */
import { type Job } from "pg-boss";

import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { syncUserPolar } from "@/lib/polar/sync";
import { getWorkerPrisma } from "./shared";

export interface PolarSyncPayload {
  userId?: string;
}

export async function handlePolarSync(jobs: Job<PolarSyncPayload>[]) {
  await withBackgroundEvent("job.polar_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        const users = await prisma.user.findMany({
          where: { polarAccessTokenEncrypted: { not: null } },
          select: { id: true },
        });
        targets.push(...users.map((u) => ({ userId: u.id })));
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          measurementsImported += await syncUserPolar(userId);
          usersSynced++;
        } catch (err) {
          evt.addWarning(`job.polar_sync failed for user ${userId}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.polar_sync",
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
