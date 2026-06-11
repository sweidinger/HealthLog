/**
 * Medication maintenance: inventory expiry and intake auto-skip handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { type MedicationInventoryExpirePayload } from "@/lib/jobs/medication-inventory-expire";
import {
  type IntakeAutoSkipPayload,
  runIntakeAutoSkipPass,
} from "@/lib/jobs/intake-auto-skip";
import { withBackgroundEvent } from "@/lib/logging/background";
import { expireStaleInUseItems } from "@/lib/medications/inventory/service";
import { getWorkerPrisma } from "./shared";

/**
 * v1.4.25 W19b — daily expire-stale pass for `MedicationInventoryItem`
 * rows. Flips IN_USE pens whose 30-day window has lapsed to EXPIRED
 * via the pure state-machine evaluator.
 */
export async function handleMedicationInventoryExpire(
  jobs: Job<MedicationInventoryExpirePayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.medication_inventory_expire", async (evt) => {
    try {
      const count = await expireStaleInUseItems({ nowMs: Date.now() });
      evt.addMeta("inventory_expired_count", count);
    } catch (err) {
      evt.addWarning(
        `medication-inventory-expire failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

/**
 * v1.4.46 — hourly auto-skip for stale unmarked medication intakes.
 *
 * Flips `MedicationIntakeEvent.skipped` to `true` for every event the
 * user neither took nor explicitly skipped within the 24 h grace
 * window. The pure helper lives in `@/lib/jobs/intake-auto-skip` so a
 * unit test can drive it with an in-memory fake Prisma; this wrapper
 * threads the worker's pg-boss + background-event plumbing.
 */
export async function handleIntakeAutoSkip(jobs: Job<IntakeAutoSkipPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.intake_auto_skip", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const result = await runIntakeAutoSkipPass(prisma, {
        nowMs: Date.now(),
      });
      evt.addMeta("intake_auto_skip_count", result.skippedCount);
      evt.addMeta("intake_auto_skip_cutoff", result.cutoff.toISOString());
    } catch (err) {
      evt.addWarning(
        `intake-auto-skip failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}
