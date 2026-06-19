/**
 * Rollup / consolidation queue registrar.
 *
 * Owns the pre-aggregation + consolidation tier: measurement-rollup recompute
 * + boot-backfill, mood-rollup recompute + boot-backfill, medication-compliance
 * boot-backfill, legacy step consolidation, daily-mean consolidation, dense
 * intra-day retention, and the nightly per-sample cumulative drain (which also
 * folds the daily-mean + dense-retention passes onto the same tick). Includes
 * the boot-time discovery enqueues for the self-converging backfills.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `boss.work(QUEUE, …, handler)` binding drains it. The
 * `drain-cumulative-queue`, `mean-consolidation-queue`, and
 * `stress-strain-retention-queue` (dense-retention facet) guards read THIS
 * module.
 */
import { PgBoss } from "pg-boss";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { recordError } from "@/lib/jobs/worker-status";
import {
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_FULL_BACKFILL_CONCURRENCY,
  ROLLUP_RECOMPUTE_QUEUE,
  ROLLUP_RECOMPUTE_CONCURRENCY,
  enqueueBootTimeRollupBackfill,
  recomputeUserRollups,
  type RollupFullBackfillPayload,
  type RollupRecomputePayload,
} from "@/lib/rollups/measurement-rollups";
import {
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY,
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
  MOOD_ROLLUP_RECOMPUTE_CONCURRENCY,
  enqueueBootTimeMoodRollupBackfill,
  recomputeUserMoodRollups,
  type MoodRollupFullBackfillPayload,
  type MoodRollupRecomputePayload,
} from "@/lib/rollups/mood-rollups";
import {
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
  MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY,
  recomputeUserMedicationCompliance,
  enqueueBootTimeMedicationComplianceBackfill,
  type MedicationComplianceBackfillPayload,
} from "@/lib/rollups/medication-compliance-rollups";
import {
  drainPerSampleCumulative,
  DRAIN_CUMULATIVE_CUTOFF_HOURS,
} from "@/lib/measurements/drain-per-sample-cumulative";
import {
  consolidateDailyMean,
  MEAN_CONSOLIDATION_CUTOFF_HOURS,
} from "@/lib/measurements/consolidate-daily-mean";
import {
  STEP_CONSOLIDATION_QUEUE,
  STEP_CONSOLIDATION_CONCURRENCY,
  runStepConsolidationForUser,
  enqueueBootTimeStepConsolidation,
  type StepConsolidationPayload,
} from "@/lib/jobs/step-consolidation";
import {
  MEAN_CONSOLIDATION_QUEUE,
  MEAN_CONSOLIDATION_CONCURRENCY,
  runMeanConsolidationForUser,
  enqueueBootTimeMeanConsolidation,
  type MeanConsolidationPayload,
} from "@/lib/jobs/mean-consolidation";
import {
  DENSE_INTRADAY_RETENTION_QUEUE,
  DENSE_INTRADAY_RETENTION_CONCURRENCY,
  runDenseIntradayRetentionForUser,
  enqueueBootTimeDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_ENABLED,
  type DenseIntradayRetentionPayload,
} from "@/lib/jobs/dense-intraday-retention";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import { getWorkerPrisma, workerLog } from "./shared";
import { createAndSchedule, type ScheduleEntry } from "./registrar-shared";
// v1.4.37 W7c — nightly drain of per-sample APPLE_HEALTH cumulative rows.
// Collapses each user × cumulative-type × calendar-day bucket into one
// `stats:…` row so the list view stops painting hundreds of step chunks per
// day. 03:45 Europe/Berlin slots in between the 03:15 audit-log cleanup and
// the 04:00 feedback aggregator. The 36-hour grace window keeps today + the
// trailing watch-sync window intact for real-time visibility; only
// completed-and-stable days fall to the drain.

const DRAIN_CUMULATIVE_QUEUE = "drain-per-sample-cumulative";

const DRAIN_CUMULATIVE_CRON = "45 3 * * *";

interface DrainCumulativePayload {
  triggeredAt: string;
}

const allQueues = [
  ROLLUP_RECOMPUTE_QUEUE,
  ROLLUP_FULL_BACKFILL_QUEUE,
  // v1.4.39 W-MOOD — per-bucket WEEK/MONTH/YEAR fold queue for the
  // mood rollup tier. The DAY pass runs inline in the write hook;
  // these enqueue paths cover the cross-granularity buckets the
  // worker materialises off the request path.
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
  // v1.4.39 W-MOOD — boot-time fold queue for the mood rollup tier.
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  // v1.4.39 W-MED — boot-time fold for the medication-compliance
  // rollup tier. Discovery enqueues one job per user with intake
  // events but no rollup coverage; idempotent across reboots.
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
  // v1.5.6 — boot-time legacy step consolidation. Discovery enqueues
  // one job per user still holding live pre-v1.5.0 granular step rows.
  STEP_CONSOLIDATION_QUEUE,
  // v1.7.0 — daily-mean consolidation for high-frequency spot HealthKit
  // metrics (walking speed/step length, respiratory rate, audio exposure).
  MEAN_CONSOLIDATION_QUEUE,
  // v1.10.0 — computed scores (WX-E). Dense intra-day retention drain of
  // daytime HRV / HR samples (per-user backfill queue, boot-discovery
  // driven like mean-consolidation; the steady-state nightly walk folds
  // onto the drain-cumulative tick).
  DENSE_INTRADAY_RETENTION_QUEUE,
  // v1.4.37 W7c — explicit createQueue is required before the nightly
  // schedule below registers (pg-boss v12 contract). Without this entry the
  // drain schedule silently no-ops and the per-sample APPLE_HEALTH rows
  // never collapse.
  DRAIN_CUMULATIVE_QUEUE,
];

const schedules: ScheduleEntry[] = [
  // v1.4.37 W7c — nightly fold of per-sample APPLE_HEALTH cumulative
  // rows into one row per day per type. Slots between the
  // audit-log cleanup (03:15) and the feedback aggregator (04:00).
  [DRAIN_CUMULATIVE_QUEUE, DRAIN_CUMULATIVE_CRON],
];

/**
 * Register every rollup / consolidation queue. Returns the queue names created
 * (for the boot-level aggregate assertion).
 */
export async function registerRollupQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules);

  // v1.5.0 — persistent measurement rollup worker. Folds the
  // WEEK / MONTH / YEAR buckets that the write-path hooks enqueue;
  // the DAY bucket is already recomputed synchronously by the hook
  // itself. Concurrency-2 keeps two recomputes in flight without
  // crowding the dashboard request pool.
  await boss.work<RollupRecomputePayload>(
    ROLLUP_RECOMPUTE_QUEUE,
    { localConcurrency: ROLLUP_RECOMPUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data;
        await recomputeUserRollups(payload.userId, {
          types: [payload.type],
          granularities: [payload.granularity],
          from: new Date(payload.from),
          to: new Date(payload.to),
        });
      }
    },
  );

  // v1.4.35.1 — boot-time full-fold worker. The boot enqueue helper
  // below sends one job per uncovered user; this handler runs the
  // full `recomputeUserRollups` against the default 5-year window
  // across every granularity. Serial concurrency so the populator
  // never crowds the dashboard request pool.
  await boss.work<RollupFullBackfillPayload>(
    ROLLUP_FULL_BACKFILL_QUEUE,
    { localConcurrency: ROLLUP_FULL_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { rowsUpserted, durationMs } = await recomputeUserRollups(userId);
        workerLog(
          "info",
          `[rollup-full-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
        );
      }
    },
  );

  // v1.5.6 — legacy step consolidation worker. The boot enqueue helper
  // below sends one job per user still holding live pre-v1.5.0 granular
  // step rows; this handler collapses them into one daily-total row per
  // calendar day and soft-deletes the originals. Serial concurrency so
  // the populator never crowds the dashboard request pool.
  await boss.work<StepConsolidationPayload>(
    STEP_CONSOLIDATION_QUEUE,
    { localConcurrency: STEP_CONSOLIDATION_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { daysConsolidated, legacyRowsSoftDeleted } =
          await runStepConsolidationForUser(userId);
        workerLog(
          "info",
          `[step-consolidation] user=${userId} days=${daysConsolidated} legacyRowsSoftDeleted=${legacyRowsSoftDeleted}`,
        );
      }
    },
  );

  // v1.7.0 — daily-mean consolidation worker. The boot enqueue helper
  // below sends one job per user holding live per-sample high-frequency
  // mean-type rows; this handler collapses each completed day to its
  // mean and soft-deletes the originals. Serial concurrency so the
  // populator never crowds the dashboard request pool.
  await boss.work<MeanConsolidationPayload>(
    MEAN_CONSOLIDATION_QUEUE,
    { localConcurrency: MEAN_CONSOLIDATION_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { daysConsolidated, perSampleRowsSoftDeleted } =
          await runMeanConsolidationForUser(userId);
        workerLog(
          "info",
          `[mean-consolidation] user=${userId} days=${daysConsolidated} perSampleRowsSoftDeleted=${perSampleRowsSoftDeleted}`,
        );
      }
    },
  );

  // v1.10.0 WX-E — dense intra-day retention per-user backfill worker. The
  // boot enqueue helper below sends one job per user holding live per-sample
  // dense-tier (HRV / HR) rows older than the retention window; this handler
  // folds those out-of-window samples to a daily mean and soft-deletes the
  // originals, keeping the in-window intra-day shape intact for the Stress
  // engine. Serial concurrency so the backfill never crowds the request pool.
  await boss.work<DenseIntradayRetentionPayload>(
    DENSE_INTRADAY_RETENTION_QUEUE,
    { localConcurrency: DENSE_INTRADAY_RETENTION_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const { daysConsolidated, perSampleRowsSoftDeleted } =
            await runDenseIntradayRetentionForUser(userId);
          workerLog(
            "info",
            `[dense-intraday-retention] user=${userId} days=${daysConsolidated} perSampleRowsSoftDeleted=${perSampleRowsSoftDeleted}`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[dense-intraday-retention] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.4.39 W-MOOD — mood-rollup per-bucket worker. Folds the
  // WEEK / MONTH / YEAR buckets that the mood-entry write hooks
  // enqueue; the DAY bucket runs synchronously in the hook itself.
  // No current read path consumes these buckets — they exist so a
  // future cross-granularity reader can ship without a backfill
  // step. Concurrency-2 mirrors the measurement-rollup worker.
  await boss.work<MoodRollupRecomputePayload>(
    MOOD_ROLLUP_RECOMPUTE_QUEUE,
    { localConcurrency: MOOD_ROLLUP_RECOMPUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data;
        await recomputeUserMoodRollups(payload.userId, {
          granularities: [payload.granularity],
          from: new Date(payload.from),
          to: new Date(payload.to),
        });
      }
    },
  );

  // v1.4.39 W-MOOD — mood-rollup boot-time fold worker. The boot
  // discovery helper below sends one job per user with mood entries
  // but zero rollup rows; this handler folds the full 5-year window
  // across every granularity. Concurrency-1 so the populator never
  // crowds the request pool.
  await boss.work<MoodRollupFullBackfillPayload>(
    MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
    { localConcurrency: MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const { rowsUpserted, durationMs } =
            await recomputeUserMoodRollups(userId);
          workerLog(
            "info",
            `[mood-rollup-full-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[mood-rollup-full-backfill] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.4.39 W-MED — medication-compliance boot-backfill worker. The
  // discovery helper below sends one job per user with intake events
  // but zero rollup coverage; this handler folds the trailing 90-day
  // window per account. Concurrency-1 so the populator never crowds
  // the request pool.
  await boss.work<MedicationComplianceBackfillPayload>(
    MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
    { localConcurrency: MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const { rowsUpserted, durationMs } =
            await recomputeUserMedicationCompliance(userId);
          workerLog(
            "info",
            `[medication-compliance-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[medication-compliance-backfill] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.4.37 W7c — nightly drain worker. Walks every user × cumulative
  // type and folds per-sample APPLE_HEALTH rows older than the cutoff
  // into one `stats:…` row per calendar day. Idempotent — a second run
  // collapses zero buckets once every day is in the `stats:` shape.
  // Concurrency-1 so the drain never crowds the dashboard request pool
  // and a long backfill on the maintainer's account (300 k+ measurement rows)
  // stays a single sequential walk.
  await boss.work<DrainCumulativePayload>(
    DRAIN_CUMULATIVE_QUEUE,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          const summary = await drainPerSampleCumulative(getWorkerPrisma(), {
            dryRun: false,
            cutoffHours: DRAIN_CUMULATIVE_CUTOFF_HOURS,
            log: (line) => workerLog("info", line),
          });
          workerLog(
            "info",
            `[drain-cumulative] triggeredAt=${job.data.triggeredAt} usersScanned=${summary.totals.usersScanned} bucketsCollapsed=${summary.totals.bucketsCollapsed} perSampleRowsDeleted=${summary.totals.perSampleRowsDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted}`,
          );
        } catch (err) {
          recordError();
          await reportWorkerError("drain-cumulative", err);
        }

        // v1.8.5 — fold the daily-MEAN drain onto the same nightly tick as
        // the cumulative (SUM) drain. The mean drain was previously
        // boot-discovery only, so between worker reboots new high-frequency
        // spot samples (walking speed, respiratory rate, gait/mobility,
        // audio exposure) accumulated raw. Running both passes on one
        // concurrency-1 cron keeps the maintenance window a single
        // sequential walk and never crowds the request pool. The global
        // (no `userId`) signature drains every user; the 36-hour grace
        // cutoff keeps today's in-flight watch syncs raw. Boot discovery
        // stays as the back-fill for accounts that accumulated raw rows
        // before this cron shipped.
        try {
          const meanSummary = await consolidateDailyMean(getWorkerPrisma(), {
            dryRun: false,
            cutoffHours: MEAN_CONSOLIDATION_CUTOFF_HOURS,
            log: (line) => workerLog("info", line),
          });
          workerLog(
            "info",
            `[mean-consolidation] triggeredAt=${job.data.triggeredAt} usersScanned=${meanSummary.totals.usersScanned} daysConsolidated=${meanSummary.totals.daysConsolidated} perSampleRowsSoftDeleted=${meanSummary.totals.perSampleRowsSoftDeleted} dailyRowsUpserted=${meanSummary.totals.dailyRowsUpserted} daysFailed=${meanSummary.totals.daysFailed}`,
          );
        } catch (err) {
          recordError();
          await reportWorkerError("mean-consolidation", err, {
            tick: "nightly",
          });
        }

        // v1.10.0 WX-E — fold the dense intra-day retention drain onto the
        // same nightly tick. Unlike the daily-mean drain, this scopes to the
        // dense-tier types (HEART_RATE_VARIABILITY, PULSE) and keeps the last
        // DENSE_INTRADAY_RETENTION_DAYS of raw per-sample rows so the Stress
        // engine still sees the intra-day SDNN shape; only out-of-window
        // samples fold to a daily mean. These two types are NEVER in the
        // destructive HIGH_FREQUENCY_MEAN_TYPES allowlist — the drain
        // exemption the intra-day shape depends on. The global (no `userId`)
        // signature drains every user. Boot discovery (below) back-fills
        // accounts that accumulated out-of-window raw rows before this
        // shipped.
        try {
          if (!DENSE_INTRADAY_RETENTION_ENABLED) {
            workerLog(
              "info",
              "[dense-intraday-retention] disabled via DENSE_INTRADAY_RETENTION_ENABLED — skipping the nightly walk (operator kill-switch)",
            );
          } else {
            const denseSummary = await runDenseIntradayRetention(
              getWorkerPrisma(),
              {
                dryRun: false,
                log: (line) => workerLog("info", line),
              },
            );
            workerLog(
              "info",
              `[dense-intraday-retention] triggeredAt=${job.data.triggeredAt} usersScanned=${denseSummary.totals.usersScanned} daysConsolidated=${denseSummary.totals.daysConsolidated} perSampleRowsSoftDeleted=${denseSummary.totals.perSampleRowsSoftDeleted} dailyRowsUpserted=${denseSummary.totals.dailyRowsUpserted}`,
            );
          }
        } catch (err) {
          recordError();
          await reportWorkerError("dense-intraday-retention", err, {
            tick: "nightly",
          });
        }
      }
    },
  );

  return allQueues;
}

/**
 * Fire-and-forget boot discovery for the self-converging rollup / consolidation
 * backfills. Each pass is idempotent across reboots and never fails worker boot
 * on a miss (errors come back through the helper's result value).
 */
export async function enqueueRollupBootDiscovery(): Promise<void> {
  // v1.4.35.1 — measurement-rollup backfill. Finds every user with
  // measurements but no rollup coverage and enqueues a full-fold per account.
  // The discovery query only matches accounts with zero rollup rows, so once
  // a fold completes the user drops off the list.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeRollupBackfill();
    if (error) {
      workerLog(
        "error",
        `[rollup-full-backfill] boot discovery failed: ${error}`,
      );
    } else {
      // v1.4.38.7 — log the discovery result on every boot, including
      // the silent `enqueued=0 skipped=0` case. Without this, an
      // operator chasing "analytics is slow" cannot tell whether the
      // discovery query ran successfully (and found nothing to fold)
      // vs. silently no-op'd. The line is one row per worker boot, so
      // the log cost is negligible.
      workerLog(
        "info",
        `[rollup-full-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[rollup-full-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.5.6 — legacy step consolidation. Finds every user still holding live
  // pre-v1.5.0 granular step rows and enqueues one consolidation job per
  // account. Consolidated legacy rows are soft-deleted, so the
  // `deleted_at IS NULL` discovery predicate drops them.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeStepConsolidation();
    if (error) {
      workerLog(
        "error",
        `[step-consolidation] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[step-consolidation] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[step-consolidation] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.7.0 — daily-mean consolidation. Finds every user holding live
  // per-sample high-frequency mean-type rows and enqueues one job per account.
  // Consolidated rows are soft-deleted, so the discovery predicate drops them.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeMeanConsolidation();
    if (error) {
      workerLog(
        "error",
        `[mean-consolidation] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[mean-consolidation] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[mean-consolidation] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.10.0 WX-E — dense intra-day retention drain. Finds every user holding
  // live per-sample dense-tier (HRV / HR) rows OLDER than the retention window
  // and enqueues one job per account. Folded rows are soft-deleted, so the
  // discovery predicate drops them.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeDenseIntradayRetention();
    if (error) {
      workerLog(
        "error",
        `[dense-intraday-retention] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[dense-intraday-retention] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[dense-intraday-retention] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MOOD — mood rollup tier. Mirrors the v1.4.35.1
  // measurement-rollup pattern: one job per user with mood entries but no
  // rollup coverage. Idempotent across reboots and singleton-keyed inside
  // pg-boss so a fast restart while a backfill is queued doesn't double up.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeMoodRollupBackfill();
    if (error) {
      workerLog(
        "error",
        `[mood-rollup-full-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[mood-rollup-full-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[mood-rollup-full-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MED — medication compliance rollup tier. Mirrors the v1.4.35.1
  // pattern: one job per user with intake events but no rollup coverage.
  // Idempotent across reboots and singleton-keyed inside pg-boss.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeMedicationComplianceBackfill();
    if (error) {
      workerLog(
        "error",
        `[medication-compliance-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[medication-compliance-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[medication-compliance-backfill] boot discovery threw an unexpected error",
      err,
    );
  }
}
