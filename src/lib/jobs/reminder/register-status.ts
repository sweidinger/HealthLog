/**
 * Status / insight / computed-score queue registrar.
 *
 * Owns the nightly per-metric insight-status ladder (general / BP / weight /
 * pulse / BMI / mood / medication-compliance), the comprehensive-insight
 * pre-generation, the on-demand per-metric status generation, the nightly
 * computed scores (recovery / stress / strain), the proactive Coach nudge, the
 * Coach memory refresh, the period-narrative warm, and the medication
 * low-stock pass.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `boss.work(QUEUE, …, handler)` binding drains it. The status-wiring
 * guards (`status-cron-candidates`, `insight-pregenerate`,
 * `insight-status-generate`, `recovery-score-queue`,
 * `stress-strain-retention-queue`, `period-narrative-warm`,
 * `coach-memory-refresh-queue`) read THIS module.
 */
import { PgBoss } from "pg-boss";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { recordError } from "@/lib/jobs/worker-status";
import {
  INSIGHT_PREGENERATE_QUEUE,
  INSIGHT_PREGENERATE_CRON,
  type InsightPregeneratePayload,
} from "@/lib/jobs/insight-pregenerate";
import {
  RECOVERY_SCORE_QUEUE,
  RECOVERY_SCORE_CRON,
  runRecoveryScore,
} from "@/lib/jobs/recovery-score";
import {
  COACH_NUDGE_QUEUE,
  COACH_NUDGE_CRON,
  runCoachNudgeTick,
} from "@/lib/jobs/coach-nudge";
import {
  MEDICATION_LOW_STOCK_QUEUE,
  MEDICATION_LOW_STOCK_CRON,
  runMedicationLowStockTick,
} from "@/lib/jobs/medication-low-stock";
import {
  STRESS_SCORE_QUEUE,
  STRESS_SCORE_CRON,
  runStressScore,
} from "@/lib/jobs/stress-score";
import {
  STRAIN_SCORE_QUEUE,
  STRAIN_SCORE_CRON,
  runStrainScore,
} from "@/lib/jobs/strain-score";
import {
  PERIOD_NARRATIVE_QUEUE,
  PERIOD_NARRATIVE_CRON,
  runPeriodNarrativeWarm,
  warmOneNarrative,
  type PeriodNarrativePayload,
} from "@/lib/jobs/period-narrative-warm";
import {
  COACH_MEMORY_REFRESH_QUEUE,
  type CoachMemoryRefreshPayload,
} from "@/lib/ai/coach/coach-memory-shared";
import { runCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-refresh-worker";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  type InsightStatusGeneratePayload,
} from "@/lib/jobs/insight-status-generate";
import { withBackgroundEvent } from "@/lib/logging/background";
import { getWorkerPrisma, workerLog } from "./shared";
import {
  createAndSchedule,
  insightRetryOptions,
  type ScheduleEntry,
} from "./registrar-shared";
import {
  GeneralStatusPayload,
  BloodPressureStatusPayload,
  WeightStatusPayload,
  PulseStatusPayload,
  BmiStatusPayload,
  MoodStatusPayload,
  MedicationComplianceStatusPayload,
  handleGeneralStatusGenerate,
  handleBloodPressureStatusGenerate,
  handleWeightStatusGenerate,
  handlePulseStatusGenerate,
  handleBmiStatusGenerate,
  handleMoodStatusGenerate,
  handleMedicationComplianceStatusGenerate,
  handleInsightPregenerateJob,
  handleInsightStatusGenerate,
} from "./insights-handlers";

const GENERAL_STATUS_QUEUE = "insights-general-status";

const GENERAL_STATUS_CRON = "0 2 * * *"; // daily at 02:00

const BLOOD_PRESSURE_STATUS_QUEUE = "insights-blood-pressure-status";

const BLOOD_PRESSURE_STATUS_CRON = "5 2 * * *"; // daily at 02:05

const WEIGHT_STATUS_QUEUE = "insights-weight-status";

const WEIGHT_STATUS_CRON = "10 2 * * *"; // daily at 02:10

const PULSE_STATUS_QUEUE = "insights-pulse-status";

const PULSE_STATUS_CRON = "15 2 * * *"; // daily at 02:15

const BMI_STATUS_QUEUE = "insights-bmi-status";

const BMI_STATUS_CRON = "20 2 * * *"; // daily at 02:20
// v1.15.20 — mood joins the nightly per-metric status ladder. Same gate +
// discovery as the six older crons (see status-cron-candidates.ts); 02:30
// continues the 5-minute stagger after BMI (02:20) and compliance (02:25).

const MOOD_STATUS_QUEUE = "insights-mood-status";

const MOOD_STATUS_CRON = "30 2 * * *"; // daily at 02:30

const MEDICATION_COMPLIANCE_STATUS_QUEUE =
  "insights-medication-compliance-status";

const MEDICATION_COMPLIANCE_STATUS_CRON = "25 2 * * *"; // daily at 02:25

const allQueues = [
  GENERAL_STATUS_QUEUE,
  BLOOD_PRESSURE_STATUS_QUEUE,
  WEIGHT_STATUS_QUEUE,
  PULSE_STATUS_QUEUE,
  BMI_STATUS_QUEUE,
  // v1.15.20 — mood joins the nightly status ladder. The queue MUST be
  // registered here or pg-boss never provisions it and the 02:30 schedule
  // silently no-ops (the v1.4.37 dead-queue class).
  MOOD_STATUS_QUEUE,
  MEDICATION_COMPLIANCE_STATUS_QUEUE,
  // v1.7.0 — nightly comprehensive-insight pre-generation so the daily
  // briefing is warm before the user opens /insights or the dashboard
  // snapshot. Without this entry the 04:30 schedule silently no-ops.
  INSIGHT_PREGENERATE_QUEUE,
  // v1.8.3 — on-demand per-metric status generation. The read-only status
  // route enqueues here on a cold card; without this entry pg-boss never
  // provisions the queue and the enqueue silently drops. No cron schedule —
  // a send-only queue driven by navigation.
  INSIGHT_STATUS_GENERATE_QUEUE,
  // v1.10.0 — computed scores (WX-C / WX-E). Nightly Recovery / Stress /
  // Strain compute + store. The queue MUST be registered here or pg-boss
  // never provisions it and the nightly schedule silently never fires.
  RECOVERY_SCORE_QUEUE,
  STRESS_SCORE_QUEUE,
  STRAIN_SCORE_QUEUE,
  // v1.11.0 — nightly period-narrative warm + single-user warm enqueued by
  // the read-only narrative GET.
  PERIOD_NARRATIVE_QUEUE,
  // v1.11.1 — combined Coach memory-refresh (rolling conversation summary +
  // durable fact extraction), enqueued fire-and-forget from a long chat turn.
  COACH_MEMORY_REFRESH_QUEUE,
  // v1.15.20 — proactive Coach nudge. Without this entry the daily 05:15
  // schedule silently no-ops and no nudge ever fires.
  COACH_NUDGE_QUEUE,
  // v1.16.11 — daily medication low-stock pass. Without this entry the 09:00
  // schedule silently no-ops and no low-stock alert ever fires.
  MEDICATION_LOW_STOCK_QUEUE,
];

const schedules: ScheduleEntry[] = [
  [GENERAL_STATUS_QUEUE, GENERAL_STATUS_CRON, insightRetryOptions],
  [
    BLOOD_PRESSURE_STATUS_QUEUE,
    BLOOD_PRESSURE_STATUS_CRON,
    insightRetryOptions,
  ],
  [WEIGHT_STATUS_QUEUE, WEIGHT_STATUS_CRON, insightRetryOptions],
  [PULSE_STATUS_QUEUE, PULSE_STATUS_CRON, insightRetryOptions],
  [BMI_STATUS_QUEUE, BMI_STATUS_CRON, insightRetryOptions],
  // v1.15.20 — mood status nightly, continuing the 02:xx ladder.
  [MOOD_STATUS_QUEUE, MOOD_STATUS_CRON, insightRetryOptions],
  [
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    MEDICATION_COMPLIANCE_STATUS_CRON,
    insightRetryOptions,
  ],
  // v1.7.0 — nightly 04:30 Europe/Berlin comprehensive-insight
  // pre-generation. Budget-gated per user inside the handler.
  [INSIGHT_PREGENERATE_QUEUE, INSIGHT_PREGENERATE_CRON, insightRetryOptions],
  // v1.10.0 — computed scores (WX-C). Nightly 04:45 Europe/Berlin
  // Recovery-score compute + store, after the rollup-feeding consolidation
  // + drain so the signals it reads are already folded.
  [RECOVERY_SCORE_QUEUE, RECOVERY_SCORE_CRON],
  // v1.10.0 — computed scores (WX-E). Nightly 04:50 Europe/Berlin
  // Stress-score compute + store, after the dense intra-day retention
  // drain so the HRV inputs it reads are settled.
  [STRESS_SCORE_QUEUE, STRESS_SCORE_CRON],
  // v1.10.0 — computed scores (WX-E). Nightly 04:55 Europe/Berlin
  // Strain-score compute + store, after the recovery + stress passes so
  // the nightly score writes stay ordered.
  [STRAIN_SCORE_QUEUE, STRAIN_SCORE_CRON],
  // v1.11.0 — nightly 05:05 Europe/Berlin period-narrative warm. The
  // handler only fans out on a week (Mon) / month (1st) boundary; every
  // other night is a cheap no-op. Budget-gated per user inside the runner.
  [PERIOD_NARRATIVE_QUEUE, PERIOD_NARRATIVE_CRON, insightRetryOptions],
  // v1.15.20 — daily 05:15 Europe/Berlin proactive Coach nudge, after
  // the 04:45–04:55 score crons so the recovery-score trigger reads
  // settled rows. Deterministic triggers only — no AI call on this path.
  [COACH_NUDGE_QUEUE, COACH_NUDGE_CRON],
  // v1.16.11 — medication low-stock pass at 09:00 Europe/Berlin: a
  // supply alert is an errand prompt, so it fires at a time the user
  // can act on it. Once daily; the per-medication stamp keeps it at
  // one push per threshold crossing.
  [MEDICATION_LOW_STOCK_QUEUE, MEDICATION_LOW_STOCK_CRON],
];

/**
 * Register every status / insight / computed-score queue. Returns the queue
 * names created (for the boot-level aggregate assertion).
 */
export async function registerStatusQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules);

  await boss.work<GeneralStatusPayload>(
    GENERAL_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleGeneralStatusGenerate,
  );
  await boss.work<BloodPressureStatusPayload>(
    BLOOD_PRESSURE_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleBloodPressureStatusGenerate,
  );
  await boss.work<WeightStatusPayload>(
    WEIGHT_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleWeightStatusGenerate,
  );
  await boss.work<PulseStatusPayload>(
    PULSE_STATUS_QUEUE,
    { localConcurrency: 1 },
    handlePulseStatusGenerate,
  );
  await boss.work<BmiStatusPayload>(
    BMI_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleBmiStatusGenerate,
  );
  await boss.work<MoodStatusPayload>(
    MOOD_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleMoodStatusGenerate,
  );
  await boss.work<MedicationComplianceStatusPayload>(
    MEDICATION_COMPLIANCE_STATUS_QUEUE,
    { localConcurrency: 1 },
    handleMedicationComplianceStatusGenerate,
  );
  // v1.7.0 — nightly comprehensive-insight pre-generation.
  //
  // v1.16.8 — localConcurrency 2 (was 1). The queue carries BOTH the
  // scheduled 04:30 cohort walk AND the visit-triggered per-user force
  // warms; with a single slot a force warm enqueued during the nightly
  // batch sat behind the entire cohort and the visiting user stared at
  // a cold dashboard for the duration. Two slots let one force warm run
  // alongside the batch while still bounding provider-level concurrency
  // (the cohort walk is itself sequential per user, and the content-hash
  // gate + per-user budget gate inside the handler cover the rare
  // double-tick overlap the old single slot serialised away).
  await boss.work<InsightPregeneratePayload>(
    INSIGHT_PREGENERATE_QUEUE,
    { localConcurrency: 2 },
    handleInsightPregenerateJob,
  );
  // v1.8.3 — on-demand per-metric status generation enqueued by the
  // read-only status route on a cold card. Low concurrency so a first
  // visit that cold-misses several cards can't saturate the Prisma pool
  // or fan out an unbounded number of concurrent provider calls.
  await boss.work<InsightStatusGeneratePayload>(
    INSIGHT_STATUS_GENERATE_QUEUE,
    { localConcurrency: INSIGHT_STATUS_GENERATE_CONCURRENCY },
    handleInsightStatusGenerate,
  );
  // v1.10.0 — computed scores (WX-C). Nightly Recovery-score compute +
  // store. The cron tick carries an empty payload; the runner iterates every
  // eligible user and upserts one `COMPUTED RECOVERY_SCORE` row per scored
  // day (idempotent — a re-fire overwrites in place). Single-flight so two
  // ticks never double-walk the cohort.
  await boss.work(RECOVERY_SCORE_QUEUE, { localConcurrency: 1 }, async () => {
    try {
      const summary = await runRecoveryScore(getWorkerPrisma());
      workerLog(
        "info",
        `[recovery-score] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
      );
    } catch (err) {
      recordError();
      workerLog("error", "[recovery-score] pass failed", err);
      throw err;
    }
  });
  // v1.15.20 — proactive Coach nudge. Single-flight; the push-attempts
  // ledger caps a user at one nudge per rolling week, so an overlapping
  // tick would only waste reads. Deterministic triggers, no AI call.
  await boss.work(COACH_NUDGE_QUEUE, { localConcurrency: 1 }, async () => {
    await withBackgroundEvent("job.coach_nudge", async (evt) => {
      try {
        const summary = await runCoachNudgeTick(getWorkerPrisma(), new Date());
        evt.setBackground({
          task_name: "job.coach_nudge",
          result: {
            candidates_scanned: summary.candidatesScanned,
            dispatched: summary.dispatched,
            persisted: summary.persisted,
            skipped_opted_out: summary.skippedOptedOut,
            skipped_no_provider: summary.skippedNoProvider,
            skipped_recent_nudge: summary.skippedRecentNudge,
            skipped_no_trigger: summary.skippedNoTrigger,
            skipped_no_channel: summary.skippedNoChannel,
            failed: summary.failed,
          },
        });
      } catch (err) {
        evt.setError(err);
        recordError();
        throw err;
      }
    });
  });
  // v1.16.11 — medication low-stock pass. Single-flight; the
  // per-medication stamp makes a re-fire idempotent (already-notified
  // crossings skip), so an overlapping tick would only waste reads.
  await boss.work(
    MEDICATION_LOW_STOCK_QUEUE,
    { localConcurrency: 1 },
    async () => {
      await withBackgroundEvent("job.medication_low_stock", async (evt) => {
        try {
          const summary = await runMedicationLowStockTick(
            getWorkerPrisma(),
            new Date(),
          );
          evt.setBackground({
            task_name: "job.medication_low_stock",
            result: {
              users_scanned: summary.usersScanned,
              skipped_threshold_off: summary.skippedThresholdOff,
              medications_evaluated: summary.medicationsEvaluated,
              notified: summary.notified,
              rearmed: summary.rearmed,
              skipped_already_notified: summary.skippedAlreadyNotified,
              skipped_above_threshold: summary.skippedAboveThreshold,
              skipped_no_runway: summary.skippedNoRunway,
              skipped_no_channel: summary.skippedNoChannel,
              failed: summary.failed,
            },
          });
        } catch (err) {
          evt.setError(err);
          recordError();
          throw err;
        }
      });
    },
  );
  // v1.10.0 — computed scores (WX-E). Nightly Stress-score (HRV-derived
  // proxy) compute + store. Single-flight so two ticks never double-walk
  // the cohort. The runner iterates every eligible user and upserts one
  // `COMPUTED STRESS_SCORE` row per scored day (idempotent — a re-fire
  // overwrites in place).
  await boss.work(STRESS_SCORE_QUEUE, { localConcurrency: 1 }, async () => {
    try {
      const summary = await runStressScore(getWorkerPrisma());
      workerLog(
        "info",
        `[stress-score] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
      );
    } catch (err) {
      recordError();
      workerLog("error", "[stress-score] pass failed", err);
      throw err;
    }
  });
  // v1.10.0 — computed scores (WX-E). Nightly Strain-score (Banister TRIMP
  // cardio-load) compute + store. Single-flight; upserts one `COMPUTED
  // STRAIN_SCORE` row per scored day (idempotent).
  await boss.work(STRAIN_SCORE_QUEUE, { localConcurrency: 1 }, async () => {
    try {
      const summary = await runStrainScore(getWorkerPrisma());
      workerLog(
        "info",
        `[strain-score] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
      );
    } catch (err) {
      recordError();
      workerLog("error", "[strain-score] pass failed", err);
      throw err;
    }
  });
  // v1.11.0 — period-narrative warm. A scheduled tick (no `userId`) runs the
  // boundary-gated nightly fan-out; a `userId` payload runs a single-user warm
  // enqueued by the read-only GET on a cold/stale read. Single-flight so two
  // ticks never double-walk the cohort; the per-user budget gate covers the
  // fan-out and the enqueue `singletonKey` covers the single-user path.
  await boss.work<PeriodNarrativePayload>(
    PERIOD_NARRATIVE_QUEUE,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          if (job.data?.userId) {
            await warmOneNarrative(job.data);
          } else {
            const summary = await runPeriodNarrativeWarm(getWorkerPrisma());
            workerLog(
              "info",
              `[period-narrative] periods=${summary.periods.join(",") || "none"} total=${summary.total} generated=${summary.generated} cached=${summary.cached} skipped=${summary.skipped} insufficient=${summary.insufficient} failed=${summary.failed} budget=${summary.budgetBlocked}`,
            );
          }
        } catch (err) {
          recordError();
          await reportWorkerError(PERIOD_NARRATIVE_QUEUE, err, {
            mode: job.data?.userId ? "single-user" : "scheduled",
          });
          throw err;
        }
      }
    },
  );
  // v1.11.1 — combined Coach memory refresh: rolling conversation summary +
  // durable fact extraction for one long conversation. localConcurrency 1 so a
  // burst of long-conversation turns can't fan out concurrent provider calls;
  // each step is budget-gated inside runStatusCompletion and fault-isolated.
  await boss.work<CoachMemoryRefreshPayload>(
    COACH_MEMORY_REFRESH_QUEUE,
    { localConcurrency: 1 },
    async (jobs) => {
      for (const job of jobs) {
        if (!job.data?.conversationId || !job.data?.userId) continue;
        try {
          await runCoachMemoryRefresh(job.data);
        } catch (err) {
          recordError();
          workerLog("error", "[coach-memory-refresh] failed", err);
          throw err;
        }
      }
    },
  );

  return allQueues;
}
