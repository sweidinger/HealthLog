/**
 * moodLog hourly sync handler.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { syncMoodLogEntries } from "@/lib/moodlog/sync";
import { getWorkerPrisma } from "./shared";

export interface MoodLogSyncPayload {
  triggeredAt: string;
}

/**
 * Fallback polling for moodLog data.
 * Syncs mood entries for all users with moodLog enabled.
 */
export async function handleMoodLogSync(jobs: Job<MoodLogSyncPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.moodlog_sync", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      // Check global toggle
      const appSettings = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: { moodLogGlobal: true },
      });
      if (appSettings && !appSettings.moodLogGlobal) {
        evt.addMeta("skipped", "global_toggle_disabled");
        return;
      }

      const users = await prisma.user.findMany({
        where: { moodLogEnabled: true },
        select: { id: true },
      });

      if (users.length === 0) return;

      let synced = 0;
      let totalImported = 0;

      for (const user of users) {
        try {
          const imported = await syncMoodLogEntries(user.id);
          synced++;
          totalImported += imported;
        } catch (err) {
          evt.addWarning(`Fallback sync failed for user ${user.id}: ${err}`);
        }
      }

      evt.setBackground({
        task_name: "job.moodlog_sync",
        result: {
          synced,
          total: users.length,
          entries_imported: totalImported,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
