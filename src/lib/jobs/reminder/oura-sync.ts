/**
 * v1.17.0 (F4) — Oura poll-cohort sync handler.
 *
 * Poll-only: one hourly cron tick (no `userId`) iterates every user with a
 * stored Oura token and re-syncs each via `syncUserOura`. One user's revoked
 * grant / outage is warned and the pass continues. The queue name, cron
 * schedule, and boss.work registration live in reminder-worker.ts.
 */
import { type Job } from "pg-boss";

import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { syncUserOura } from "@/lib/oura/sync";
import { getWorkerPrisma } from "./shared";

export interface OuraSyncPayload {
  userId?: string;
}

export async function handleOuraSync(jobs: Job<OuraSyncPayload>[]) {
  await withBackgroundEvent("job.oura_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const targets: Array<{ userId: string }> = [];
      for (const job of jobs) {
        if (job.data?.userId) targets.push({ userId: job.data.userId });
      }
      if (targets.length === 0) {
        const users = await prisma.user.findMany({
          where: { ouraAccessTokenEncrypted: { not: null } },
          select: { id: true },
        });
        targets.push(...users.map((u) => ({ userId: u.id })));
      }
      if (targets.length === 0) return;

      let usersSynced = 0;
      let measurementsImported = 0;
      for (const { userId } of targets) {
        try {
          measurementsImported += await syncUserOura(userId);
          usersSynced++;
        } catch (err) {
          evt.addWarning(`job.oura_sync failed for user ${userId}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.oura_sync",
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
