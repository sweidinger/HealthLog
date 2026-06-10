/**
 * Mood-reminder and cycle-reminder 15-minute tick handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";
import { runMoodReminderTick } from "@/lib/jobs/mood-reminder";
import { runCycleReminderTick } from "@/lib/jobs/cycle-reminder";
import { getWorkerPrisma } from "./shared";

export interface MoodReminderPayload {
  triggeredAt: string;
}

export interface CycleReminderPayload {
  triggeredAt: string;
}

export async function handleMoodReminderCheck(
  jobs: Job<MoodReminderPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.mood_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const summary = await runMoodReminderTick(prisma, new Date());
      evt.setBackground({
        task_name: "job.mood_reminder",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_window: summary.inWindow,
          dispatched: summary.dispatched,
          skipped_already_logged: summary.skippedAlreadyLogged,
          skipped_already_dispatched: summary.skippedAlreadyDispatched,
          skipped_outside_window: summary.skippedOutsideWindow,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * v1.15 — daily cycle-reminder dispatcher (period-soon + period-start-confirm).
 *
 * Thin shim around `runCycleReminderTick` in `cycle-reminder.ts` so the
 * unit tests exercise the windowing + suppression logic without pg-boss.
 */
export async function handleCycleReminderCheck(
  jobs: Job<CycleReminderPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.cycle_reminder", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const summary = await runCycleReminderTick(prisma, new Date());
      evt.setBackground({
        task_name: "job.cycle_reminder",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_window: summary.inWindow,
          dispatched_period_soon: summary.dispatchedPeriodSoon,
          dispatched_period_confirm: summary.dispatchedPeriodConfirm,
          suppressed_client_managed: summary.suppressedClientManaged,
          suppressed_discreet: summary.suppressedDiscreet,
          skipped_already_notified: summary.skippedAlreadyNotified,
          skipped_outside_window: summary.skippedOutsideWindow,
        },
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
