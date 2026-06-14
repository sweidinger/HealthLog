/**
 * pg-boss based reminder worker.
 * Checks for overdue medication intakes and creates reminder events.
 * Sends notifications via the dispatcher (Telegram, ntfy, Web Push).
 *
 * Usage: Run as a standalone process or call startReminderWorker() from a
 * custom server setup. In dev, use: npx tsx src/lib/jobs/reminder-worker.ts
 */
import { PgBoss } from "pg-boss";
import {
  WHOOP_BACKFILL_QUEUE,
  WHOOP_BACKFILL_CONCURRENCY,
  runWhoopBackfillForUser,
  enqueueBootTimeWhoopBackfill,
  type WhoopBackfillPayload,
} from "@/lib/jobs/whoop-backfill";
import {
  FITBIT_BACKFILL_QUEUE,
  FITBIT_BACKFILL_CONCURRENCY,
  runFitbitBackfillForUser,
  enqueueBootTimeFitbitBackfill,
  type FitbitBackfillPayload,
} from "@/lib/jobs/fitbit-backfill";
import {
  SLEEP_TIMELINE_BACKFILL_QUEUE,
  SLEEP_TIMELINE_BACKFILL_CONCURRENCY,
  runSleepTimelineBackfillForUser,
  enqueueBootTimeSleepTimelineBackfill,
  type SleepTimelineBackfillPayload,
} from "@/lib/jobs/sleep-timeline-backfill";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { markWorkerStarted, recordError } from "@/lib/jobs/worker-status";
import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import { GEO_BACKFILL_QUEUE, GEO_BACKFILL_CRON } from "@/lib/jobs/geo-backfill";
import {
  TLS_PIN_MONITOR_QUEUE,
  TLS_PIN_MONITOR_CRON,
} from "@/lib/jobs/tls-pin-monitor";
import {
  PR_DETECTION_QUEUE,
  PR_DETECTION_CONCURRENCY,
  PR_DETECTION_FALLBACK_CRON,
  type PrDetectionPayload,
} from "@/lib/jobs/pr-detection";
import {
  MEDICATION_INVENTORY_EXPIRE_QUEUE,
  MEDICATION_INVENTORY_EXPIRE_CRON,
  type MedicationInventoryExpirePayload,
} from "@/lib/jobs/medication-inventory-expire";
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
  DENSE_INTRADAY_RETENTION_QUEUE,
  DENSE_INTRADAY_RETENTION_CONCURRENCY,
  runDenseIntradayRetentionForUser,
  enqueueBootTimeDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_ENABLED,
  type DenseIntradayRetentionPayload,
} from "@/lib/jobs/dense-intraday-retention";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  type InsightStatusGeneratePayload,
} from "@/lib/jobs/insight-status-generate";
import {
  INTAKE_AUTO_SKIP_QUEUE,
  INTAKE_AUTO_SKIP_CRON,
  type IntakeAutoSkipPayload,
} from "@/lib/jobs/intake-auto-skip";
import {
  APPLE_HEALTH_IMPORT_QUEUE,
  APPLE_HEALTH_IMPORT_CONCURRENCY,
  handleAppleHealthImport,
  reconcileOrphanImportJobs,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
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
  INTAKE_SLOT_DEDUP_QUEUE,
  INTAKE_SLOT_DEDUP_CONCURRENCY,
  dedupeUserIntakeSlots,
  enqueueBootTimeIntakeSlotDedup,
  type IntakeSlotDedupPayload,
} from "@/lib/medications/intake-slot-dedup";
import { rotateLegacyMoodLogSecrets } from "@/lib/moodlog-secret";
import { probeIntegrationStatusNullBuckets } from "@/lib/jobs/integration-status-null-probe";
import { withBackgroundEvent } from "@/lib/logging/background";
import { assertSubsystemEnabled } from "@/lib/process-type";
import {
  handleRestoreDrill,
  RESTORE_DRILL_CRON,
  RESTORE_DRILL_QUEUE,
} from "@/lib/jobs/restore-drill";
import { DATABASE_URL, getWorkerPrisma, workerLog } from "./reminder/shared";
import {
  ReminderCheckPayload,
  handleReminderCheck,
} from "./reminder/medication-reminder-check";
import {
  WithingsSyncPayload,
  WithingsActivitySyncPayload,
  WithingsSleepSyncPayload,
  handleWithingsFallbackSync,
  handleWithingsActivitySync,
  handleWithingsSleepSync,
} from "./reminder/withings-sync";
import {
  WhoopSyncPayload,
  handleWhoopRecoverySync,
  handleWhoopSleepSync,
  handleWhoopWorkoutSync,
  handleWhoopCycleSync,
} from "./reminder/whoop-sync";
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
} from "./reminder/insights-handlers";
import { MoodLogSyncPayload, handleMoodLogSync } from "./reminder/moodlog-sync";
import {
  DataBackupPayload,
  OffhostBackupPayload,
  handleOffhostBackup,
  handleDataBackup,
} from "./reminder/backup-handlers";
import {
  RateLimitCleanupPayload,
  IdempotencyCleanupPayload,
  AuditLogCleanupPayload,
  WithingsOAuthStateCleanupPayload,
  MoodReminderCleanupPayload,
  handleMoodReminderCleanup,
  PushAttemptCleanupPayload,
  handlePushAttemptCleanup,
  MeasurementTombstoneCleanupPayload,
  handleMeasurementTombstoneCleanup,
  handleRateLimitCleanup,
  handleIdempotencyCleanup,
  handleAuditLogCleanup,
  handleWithingsOAuthStateCleanup,
  WhoopOAuthStateCleanupPayload,
  handleWhoopOAuthStateCleanup,
} from "./reminder/cleanup-handlers";
import {
  MoodReminderPayload,
  CycleReminderPayload,
  handleMoodReminderCheck,
  handleCycleReminderCheck,
} from "./reminder/mood-cycle-checks";
import {
  HostMetricSamplePayload,
  FeedbackAggregatorPayload,
  GeoBackfillPayload,
  TlsPinMonitorPayload,
  handleHostMetricSample,
  handleFeedbackAggregator,
  handleGeoBackfill,
  handleTlsPinMonitor,
  handlePrDetection,
} from "./reminder/ops-handlers";
import {
  FitbitSyncPayload,
  handleFitbitSync,
  FitbitOAuthStateCleanupPayload,
  handleFitbitOAuthStateCleanup,
} from "./reminder/fitbit-sync";
import {
  NightscoutSyncPayload,
  handleNightscoutSync,
} from "./reminder/nightscout-sync";
import { PolarSyncPayload, handlePolarSync } from "./reminder/polar-sync";
import { OuraSyncPayload, handleOuraSync } from "./reminder/oura-sync";
import {
  handleMedicationInventoryExpire,
  handleIntakeAutoSkip,
} from "./reminder/medication-maintenance";

const QUEUE_NAME = "medication-reminder-check";

const CHECK_INTERVAL_CRON = "*/15 * * * *"; // every 15 minutes

const WITHINGS_SYNC_QUEUE = "withings-fallback-sync";

const WITHINGS_SYNC_CRON = "0 * * * *"; // every 60 minutes
// v1.4.25 W17b/c — webhook-primary + cron-safety-net for activity and
// sleep v2. The webhook handler enqueues per-user jobs on appli=16 / 44
// notifications; the crons below are the catch-net for the 1 % of
// notifications Withings drops. Offset 15-minute cadence per the
// research recommendation so the two queues don't lockstep against the
// existing measure cron at :00.

const WITHINGS_ACTIVITY_QUEUE = "withings-activity-sync";

const WITHINGS_ACTIVITY_CRON = "0 * * * *"; // every hour at :00

const WITHINGS_SLEEP_QUEUE = "withings-sleep-sync";

const WITHINGS_SLEEP_CRON = "15 * * * *"; // every hour at :15

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

const MOODLOG_SYNC_QUEUE = "moodlog-sync";

const MOODLOG_SYNC_CRON = "30 * * * *"; // every hour at :30

const DATA_BACKUP_QUEUE = "data-backup";

const DATA_BACKUP_CRON = "0 3 * * 0"; // weekly Sunday at 03:00

const RATE_LIMIT_CLEANUP_QUEUE = "rate-limit-cleanup";

const RATE_LIMIT_CLEANUP_CRON = "*/5 * * * *"; // every 5 minutes

const IDEMPOTENCY_CLEANUP_QUEUE = "idempotency-cleanup";

const IDEMPOTENCY_CLEANUP_CRON = "0 3 * * *"; // daily at 03:00 (Europe/Berlin)

const AUDIT_LOG_CLEANUP_QUEUE = "audit-log-cleanup";

const AUDIT_LOG_CLEANUP_CRON = "15 3 * * *"; // daily at 03:15 (Europe/Berlin)
// v1.4.47 W6 — daily sweep for the Withings OAuth state ledger. Slots
// at :20 between the audit-log cleanup (:15) and the mood-reminder
// cleanup (:25), inside the existing 02:xx-03:xx maintenance window.
// Rows are normally consumed by the callback handler in single-use
// fashion; this sweep picks up the long tail where a user closed the
// Withings approval tab without bouncing back to the callback URL.

const WITHINGS_OAUTH_STATE_CLEANUP_QUEUE = "withings-oauth-state-cleanup";

const WITHINGS_OAUTH_STATE_CLEANUP_CRON = "20 3 * * *";
// v1.11.0 — WHOOP sync queues. Webhook-primary + cron-safety-net, mirroring
// the Withings activity/sleep crons. Recovery / sleep / workout each have a
// WHOOP webhook (`*.updated`) that enqueues the matching per-resource job; the
// crons below are the catch-net for dropped deliveries. Cycle has NO webhook,
// so its cron is the only driver. Minutes are staggered off the Withings crons
// (:00/:15) to spread DB load.

const WHOOP_RECOVERY_SYNC_QUEUE = "whoop-recovery-sync";

const WHOOP_RECOVERY_SYNC_CRON = "5 * * * *"; // every hour at :05

const WHOOP_SLEEP_SYNC_QUEUE = "whoop-sleep-sync";

const WHOOP_SLEEP_SYNC_CRON = "20 * * * *"; // every hour at :20

const WHOOP_WORKOUT_SYNC_QUEUE = "whoop-workout-sync";

const WHOOP_WORKOUT_SYNC_CRON = "35 * * * *"; // every hour at :35

const WHOOP_CYCLE_SYNC_QUEUE = "whoop-cycle-sync";

const WHOOP_CYCLE_SYNC_CRON = "50 * * * *"; // every hour at :50 (poll-only)
// v1.11.0 — daily sweep for the WHOOP OAuth state ledger. Slots at 03:22,
// next to the Withings sweep (03:20), inside the maintenance window.

const WHOOP_OAUTH_STATE_CLEANUP_QUEUE = "whoop-oauth-state-cleanup";

const WHOOP_OAUTH_STATE_CLEANUP_CRON = "22 3 * * *";
// v1.12.0 — Fitbit / Google Health poll-only sync. There is no Fitbit webhook
// at launch (Pub/Sub deferred), so a single hourly cron drives the per-user
// `syncUserFitbit` driver across every connection. Minute staggered off the
// WHOOP slots (:05/:20/:35/:50) and the Withings slots (:00/:15) so the hourly
// ticks don't pile up on one boss poll.

const FITBIT_SYNC_QUEUE = "fitbit-sync";

const FITBIT_SYNC_CRON = "8 * * * *"; // every hour at :08
// v1.12.0 — daily sweep for the Fitbit OAuth state ledger. Slots at 03:24, next
// to the WHOOP sweep (03:22), inside the maintenance window.

const FITBIT_OAUTH_STATE_CLEANUP_QUEUE = "fitbit-oauth-state-cleanup";

const FITBIT_OAUTH_STATE_CLEANUP_CRON = "24 3 * * *";
// v1.17.0 — Nightscout CGM poll sync. Poll-only (no webhook): one hourly tick
// pulls the recent SGV window per configured instance. :11 staggers off the
// WHOOP (:05), Fitbit (:08), and Withings sync ticks so the hourly polls don't
// pile up on one boss poll.
const NIGHTSCOUT_SYNC_QUEUE = "nightscout-sync";

const NIGHTSCOUT_SYNC_CRON = "11 * * * *"; // every hour at :11
// v1.17.0 (F4) — Polar + Oura OAuth poll sync. Poll-only (one hourly tick per
// provider re-walks every connected user). :13 / :15 stagger off the other
// hourly sync ticks (WHOOP :05, Fitbit :08, Nightscout :11) so the polls don't
// pile up on one boss poll. The queues MUST be registered in `allQueues` below
// or pg-boss never provisions them and the schedule silently no-ops (the
// v1.4.37 dead-queue class).
const POLAR_SYNC_QUEUE = "polar-sync";
const POLAR_SYNC_CRON = "13 * * * *"; // every hour at :13
const OURA_SYNC_QUEUE = "oura-sync";
const OURA_SYNC_CRON = "15 * * * *"; // every hour at :15
// v1.15.19 — daily duplicate dose-slot dedup discovery tick. The boot-time
// pass only ran on worker restart, so a cross-source duplicate slot created
// between deploys (a pending REMINDER row plus a standalone API/WEB row on
// the same instant) survived until the next reboot. The cron payload omits
// `userId`; the handler treats that as the discovery tick and fans out one
// per-user job (singletonKey-coalesced) exactly like the boot pass. Slots at
// 03:28 between the mood-reminder cleanup (03:25) and the inventory expire
// (03:30), inside the maintenance window.

const INTAKE_SLOT_DEDUP_CRON = "28 3 * * *";

const OFFHOST_BACKUP_QUEUE = "data-backup-offhost";
// 02:30 Europe/Berlin — runs after audit-log/idempotency cleanups so old
// rows are gone before they're snapshotted, but before the existing
// in-DB DATA_BACKUP at 03:00 (Sundays only) so the off-host copy is
// always at-or-ahead of the local one.

const OFFHOST_BACKUP_CRON = "30 2 * * *";

const HOST_METRIC_QUEUE = "host-metric-sample";
// Per-minute cadence — matches the chart's 60s polling refetchInterval.

const HOST_METRIC_CRON = "* * * * *";
// v1.4.16 phase B5e — daily rec-feedback aggregator. 04:00 Europe/Berlin
// runs the slot AFTER all the cleanup jobs (rate-limit, idempotency,
// audit-log) so the previous-day's noise is gone before we aggregate.

const FEEDBACK_AGGREGATOR_QUEUE = "feedback-aggregator";

const FEEDBACK_AGGREGATOR_CRON = "0 4 * * *";
// v1.4.37 — hourly geo backfill. Queue name + cron expression live
// in `@/lib/jobs/geo-backfill` so a unit test can pin the scheduling
// contract without importing this worker boot file.
// v1.4.37 W7c — nightly drain of per-sample APPLE_HEALTH cumulative
// rows. Collapses each user × cumulative-type × calendar-day bucket
// into one `stats:…` row so the list view stops painting hundreds of
// step chunks per day. 03:45 Europe/Berlin slots in between the
// 03:15 audit-log cleanup and the 04:00 feedback aggregator. The
// 36-hour grace window keeps today + the trailing watch-sync window
// intact for real-time visibility; only completed-and-stable days
// fall to the drain.

const DRAIN_CUMULATIVE_QUEUE = "drain-per-sample-cumulative";

const DRAIN_CUMULATIVE_CRON = "45 3 * * *";
// v0.5.4 ios-coord — daily mood-reminder cron.
//
// Runs every 15 minutes so the handler can pick up users whose local
// time has just crossed 22:00 across any IANA timezone without having
// to schedule one cron entry per zone. The handler short-circuits when
// the user's local hour isn't 22, so the 15-min cadence translates to
// ~4 ticks-per-hour × 1 actual-dispatch-window-per-user = at most one
// push per user per day. Idempotency is enforced by the
// `MoodReminderDispatch` ledger inside the handler.

const MOOD_REMINDER_QUEUE = "mood-reminder-check";

const MOOD_REMINDER_CRON = "*/15 * * * *";
// v1.4.38.2 — daily retention sweep for the mood-reminder dispatch
// ledger. Rows older than 90 days are behavioural footprints of
// mood-log gaps; we keep them long enough to debug a duplicate-push
// report (~one billing cycle) but no longer. Slots between the
// audit-log cleanup (03:15) and the drain (03:45).

const MOOD_REMINDER_CLEANUP_QUEUE = "mood-reminder-cleanup";

const MOOD_REMINDER_CLEANUP_CRON = "25 3 * * *";

const PUSH_ATTEMPT_CLEANUP_QUEUE = "push-attempt-cleanup";

const PUSH_ATTEMPT_CLEANUP_CRON = "35 3 * * *";

const MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE = "measurement-tombstone-cleanup";

const MEASUREMENT_TOMBSTONE_CLEANUP_CRON = "40 3 * * *";
// v1.15 — daily cycle reminder cron (period-soon + period-start-confirm).
//
// Runs every 15 minutes for the same reason as the mood reminder: the
// handler short-circuits unless the candidate user's local time is the
// cycle-reminder hour (09:00), so the 15-min cadence picks up every IANA
// timezone crossing that hour without one cron entry per zone. At most one
// push per event per user per local day — the `push_attempts` ledger is the
// idempotency anchor inside the handler.

const CYCLE_REMINDER_QUEUE = "cycle-reminder-check";

const CYCLE_REMINDER_CRON = "*/15 * * * *";
// v1.4.38 — the per-sample cutoff hours constant now lives on the
// helper module so the worker, the admin route, and the CLI all read
// the same source of truth. Re-export pulled in alongside
// `drainPerSampleCumulative` above.

interface DrainCumulativePayload {
  triggeredAt: string;
}

export async function startReminderWorker() {
  // v1.4 G3: refuse to boot if the operator marked this container as
  // web-only via HEALTHLOG_PROCESS_TYPE.
  assertSubsystemEnabled("worker");

  if (!DATABASE_URL) {
    workerLog("error", "CRITICAL: DATABASE_URL is not set, refusing to start");
    return;
  }

  const boss = new PgBoss(DATABASE_URL);

  boss.on("error", (error: unknown) => {
    workerLog("error", "boss emitted error", error);
    recordError();
  });

  await boss.start();
  setGlobalBoss(boss);
  markWorkerStarted();

  // V3 audit STILL-V2-C-2: encrypt-at-rest one-shot migration. Rotates
  // any rows that still hold a plaintext mood_log_webhook_secret to the
  // AES-256-GCM envelope. Idempotent — encrypted rows are skipped.
  try {
    const p = getWorkerPrisma();
    const rotated = await rotateLegacyMoodLogSecrets({
      findLegacy: () =>
        p.user.findMany({
          where: { moodLogWebhookSecret: { not: null } },
          select: { id: true, moodLogWebhookSecret: true },
        }),
      rotate: async (id, encryptedSecret) => {
        await p.user.update({
          where: { id },
          data: { moodLogWebhookSecret: encryptedSecret },
        });
      },
    });
    if (rotated > 0) {
      workerLog(
        "error",
        `moodlog-secret-migration: rotated ${rotated} legacy plaintext secret(s)`,
      );
    }
  } catch (err) {
    workerLog("error", `moodlog-secret-migration failed: ${err}`);
  }

  // Graceful shutdown: drain in-flight jobs on SIGTERM/SIGINT (sent by
  // Docker Compose `docker stop`, Kubernetes pod termination, Coolify
  // redeploys). Without this, pending handlers were force-killed and could
  // either be lost or replayed on next start. We only register the listeners
  // once — re-entering startReminderWorker (e.g. on hot-reload in dev) is
  // a no-op for the handlers because they capture `boss` by closure and the
  // first signal stops everything.
  let shutdownInProgress = false;
  const onSignal = async (signal: "SIGTERM" | "SIGINT") => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    workerLog("error", `received ${signal}, draining boss`);
    try {
      // graceful=true waits for active handlers to finish, then closes the
      // pg connection pool. timeout cap so a stuck handler can't block deploys.
      await boss.stop({ graceful: true, timeout: 30_000 });
    } catch (err) {
      workerLog("error", "boss.stop failed during shutdown", err);
    }
  };
  process.once("SIGTERM", () => void onSignal("SIGTERM"));
  process.once("SIGINT", () => void onSignal("SIGINT"));

  // pg-boss v12 requires explicit queue creation before scheduling
  const allQueues = [
    QUEUE_NAME,
    WITHINGS_SYNC_QUEUE,
    WITHINGS_ACTIVITY_QUEUE,
    WITHINGS_SLEEP_QUEUE,
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
    MOODLOG_SYNC_QUEUE,
    DATA_BACKUP_QUEUE,
    RATE_LIMIT_CLEANUP_QUEUE,
    IDEMPOTENCY_CLEANUP_QUEUE,
    AUDIT_LOG_CLEANUP_QUEUE,
    // v1.4.47 W6 — daily sweep for the Withings OAuth state ledger.
    // Same pg-boss v12 createQueue contract as the other cleanup
    // crons; without this entry the schedule below silently no-ops
    // and abandoned rows pile up.
    WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    // v1.11.0 — WHOOP sync queues. Webhook-primary + cron-safety-net for
    // recovery / sleep / workout; cycle is poll-only (no WHOOP webhook).
    // Every queue MUST be registered here or pg-boss never provisions it and
    // both the webhook enqueue AND the cron schedule below silently no-op (the
    // v1.4.37 dead-queue class).
    WHOOP_RECOVERY_SYNC_QUEUE,
    WHOOP_SLEEP_SYNC_QUEUE,
    WHOOP_WORKOUT_SYNC_QUEUE,
    WHOOP_CYCLE_SYNC_QUEUE,
    // v1.11.0 — self-converging boot backfill for newly connected WHOOP
    // accounts. Discovery enqueues one full-history sync per un-backfilled
    // connection; idempotent across reboots.
    WHOOP_BACKFILL_QUEUE,
    // v1.11.0 — daily sweep for the WHOOP OAuth state ledger.
    WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
    // v1.12.0 — Fitbit / Google Health poll-only sync (no webhook at launch),
    // self-converging boot backfill, and the daily OAuth-state ledger sweep.
    // Every queue MUST be registered here or pg-boss never provisions it and the
    // schedule + boot enqueue silently no-op (the v1.4.37 dead-queue class).
    FITBIT_SYNC_QUEUE,
    FITBIT_BACKFILL_QUEUE,
    FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
    // v1.17.1 — one-shot sleep-timeline backfill for WHOOP + Withings.
    // Discovery enqueues one job per connection whose sleep rows predate the
    // stamp/shape fix; the pass deletes the affected SLEEP_DURATION rows and
    // re-syncs. Idempotent across reboots. The queue MUST be registered here or
    // pg-boss never provisions it and the boot enqueue silently never drains
    // (the v1.4.37 dead-queue class).
    SLEEP_TIMELINE_BACKFILL_QUEUE,
    // v1.17.0 — Nightscout CGM poll sync. Poll-only (no webhook, no OAuth, no
    // backfill queue — the hourly window walks the recent SGV set). The queue
    // MUST be registered here or pg-boss never provisions it and the schedule
    // below silently no-ops (the v1.4.37 dead-queue class).
    NIGHTSCOUT_SYNC_QUEUE,
    // v1.17.0 (F4) — Polar + Oura OAuth poll sync. Registered here or pg-boss
    // never provisions them and the hourly schedule below silently no-ops.
    POLAR_SYNC_QUEUE,
    OURA_SYNC_QUEUE,
    OFFHOST_BACKUP_QUEUE,
    RESTORE_DRILL_QUEUE,
    HOST_METRIC_QUEUE,
    FEEDBACK_AGGREGATOR_QUEUE,
    GEO_BACKFILL_QUEUE,
    // v1.12.2 ios-coord — TLS leaf SPKI-change monitor. The iOS client
    // pins the served leaf certificate; this queue probes it every 6 h and
    // alarms when the served SPKI leaves the operator's known-good set. The
    // queue MUST be registered here or pg-boss never provisions it and the
    // schedule below silently no-ops (the v1.4.37 dead-queue class).
    TLS_PIN_MONITOR_QUEUE,
    PR_DETECTION_QUEUE,
    MEDICATION_INVENTORY_EXPIRE_QUEUE,
    // v1.4.46 — hourly auto-skip pass for stale unmarked intakes.
    // Same pg-boss v12 createQueue contract as the other crons; without
    // this entry the schedule silently no-ops and pending rows older
    // than 24 h pile up unflipped.
    INTAKE_AUTO_SKIP_QUEUE,
    APPLE_HEALTH_IMPORT_QUEUE,
    ROLLUP_RECOMPUTE_QUEUE,
    ROLLUP_FULL_BACKFILL_QUEUE,
    // v1.4.39 W-MOOD — per-bucket WEEK/MONTH/YEAR fold queue for the
    // mood rollup tier. The DAY pass runs inline in the write hook;
    // these enqueue paths cover the cross-granularity buckets the
    // worker materialises off the request path.
    MOOD_ROLLUP_RECOMPUTE_QUEUE,
    // v1.4.39 W-MOOD — boot-time fold queue for the mood rollup tier.
    // Mirrors the measurement-rollup full-backfill semantics: the
    // discovery query enqueues one full-fold per user with mood
    // entries but no rollup rows; the user drops off the list once
    // the fold completes.
    MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
    // v1.4.39 W-MED — boot-time fold for the medication-compliance
    // rollup tier. Discovery enqueues one job per user with intake
    // events but no rollup coverage; idempotent across reboots.
    MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
    // v1.5.6 — boot-time legacy step consolidation. Discovery enqueues
    // one job per user still holding live pre-v1.5.0 granular step
    // rows; the per-user pass collapses them into one daily total and
    // soft-deletes the originals. Idempotent across reboots — a
    // consolidated user drops off the discovery list. The queue MUST be
    // registered here or pg-boss never provisions it and the boot
    // enqueue silently never drains.
    STEP_CONSOLIDATION_QUEUE,
    // v1.7.0 — daily-mean consolidation for high-frequency spot
    // HealthKit metrics (walking speed/step length, respiratory rate,
    // audio exposure). Boot discovery enqueues one job per user holding
    // live per-sample mean-type rows; the per-user pass collapses each
    // day to its mean and soft-deletes the originals. Idempotent across
    // reboots. The queue MUST be registered here or pg-boss never
    // provisions it and the boot enqueue silently never drains.
    MEAN_CONSOLIDATION_QUEUE,
    // v1.8.2 — one-time duplicate dose-slot cleanup. Boot discovery
    // enqueues one job per user holding two live intake rows that snap to
    // the same canonical slot (the pre-fix REMINDER-pending + API-taken
    // pair). The per-user pass keeps the winner (taken > skipped >
    // pending), soft-deletes the losers, and recomputes the affected
    // compliance rollups. Idempotent across reboots — a deduped user
    // falls off the discovery list. The queue MUST be registered here or
    // pg-boss never provisions it and the boot enqueue silently never
    // drains.
    INTAKE_SLOT_DEDUP_QUEUE,
    // v1.4.37 W7c — explicit createQueue is required before the
    // nightly schedule below registers (pg-boss v12 contract). Without
    // this entry the drain schedule silently no-ops and the
    // per-sample APPLE_HEALTH rows never collapse.
    DRAIN_CUMULATIVE_QUEUE,
    // v0.5.4 ios-coord — mood-reminder cron tick. Same pg-boss v12
    // createQueue contract as the drain queue above; without this
    // entry the every-15-min schedule silently no-ops and the
    // dispatcher never fires.
    MOOD_REMINDER_QUEUE,
    MOOD_REMINDER_CLEANUP_QUEUE,
    // v1.15 — cycle-reminder cron tick (period-soon + period-start-confirm).
    // Same pg-boss v12 createQueue contract as the mood-reminder queue;
    // without this entry the every-15-min schedule silently no-ops and the
    // cycle dispatcher never fires (the v1.4.37 dead-queue class).
    CYCLE_REMINDER_QUEUE,
    // v1.4.49 — push-attempt ledger cleanup. Same createQueue contract
    // as the other cleanup jobs; the daily schedule below would
    // silently no-op without this entry.
    PUSH_ATTEMPT_CLEANUP_QUEUE,
    // v1.7.0 — nightly comprehensive-insight pre-generation so the
    // daily briefing is warm before the user opens /insights or the
    // dashboard snapshot. Same pg-boss v12 createQueue contract; without
    // this entry the 04:30 schedule silently no-ops and every briefing
    // falls back to the lazy on-demand generation it was meant to retire.
    INSIGHT_PREGENERATE_QUEUE,
    // v1.8.3 — on-demand per-metric status generation. The read-only
    // status route enqueues here on a cold card; without this entry
    // pg-boss never provisions the queue and the enqueue silently drops,
    // leaving every status card stuck on "preparing". No cron schedule —
    // it is a send-only queue driven by navigation.
    INSIGHT_STATUS_GENERATE_QUEUE,
    // v1.7.0 — soft-deleted measurement tombstone prune. Same createQueue
    // contract as the other cleanup jobs; without this entry the daily
    // schedule silently no-ops and pruned-past-retention tombstones pile
    // up forever.
    MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,
    // v1.10.0 — computed scores (WX-C). Nightly Recovery-score compute +
    // store. The cron tick fans out one stored `COMPUTED RECOVERY_SCORE` row
    // per eligible user. The queue MUST be registered here or pg-boss never
    // provisions it and the 04:45 schedule silently never fires.
    RECOVERY_SCORE_QUEUE,
    // v1.10.0 — computed scores (WX-E). Nightly Stress-score (HRV-derived
    // proxy) compute + store. Same createQueue contract as the recovery
    // score; without this entry the 04:50 schedule silently never fires.
    STRESS_SCORE_QUEUE,
    // v1.10.0 — computed scores (WX-E). Nightly Strain-score (Banister TRIMP
    // cardio-load) compute + store. Same createQueue contract; without this
    // entry the 04:55 schedule silently never fires.
    STRAIN_SCORE_QUEUE,
    // v1.10.0 — computed scores (WX-E). Dense intra-day retention drain of
    // daytime HRV / HR samples (per-user backfill queue, boot-discovery
    // driven like mean-consolidation; the steady-state nightly walk folds
    // onto the drain-cumulative tick). The queue MUST be registered here or
    // the boot enqueue silently never drains.
    DENSE_INTRADAY_RETENTION_QUEUE,
    // v1.11.0 — nightly period-narrative warm + single-user warm enqueued by
    // the read-only narrative GET. The queue MUST be registered here or the
    // GET-miss enqueue silently never warms.
    PERIOD_NARRATIVE_QUEUE,
    // v1.11.1 — combined Coach memory-refresh (rolling conversation summary +
    // durable fact extraction), enqueued fire-and-forget from a long chat
    // turn. The queue MUST be registered here or the enqueue silently never
    // runs.
    COACH_MEMORY_REFRESH_QUEUE,
    // v1.15.20 — proactive Coach nudge. Same pg-boss v12 createQueue
    // contract; without this entry the daily 05:15 schedule silently
    // no-ops and no nudge ever fires.
    COACH_NUDGE_QUEUE,
    // v1.16.11 — daily medication low-stock pass. Same pg-boss v12
    // createQueue contract; without this entry the 09:00 schedule
    // silently no-ops and no low-stock alert ever fires.
    MEDICATION_LOW_STOCK_QUEUE,
  ];

  for (const q of allQueues) {
    await boss.createQueue(q);
  }

  // v1.4.34 — reconcile any `ImportJob` rows that were mid-parse when
  // the worker last shut down. Flips orphaned rows to `failed` so the
  // operator can re-upload without leaving the polling endpoint
  // stuck on `parsing` / `upserting`.
  try {
    await reconcileOrphanImportJobs();
  } catch (err) {
    workerLog("error", "Failed to reconcile orphan ImportJob rows", err);
  }

  // v1.4.48 M1 — boot probe for legacy `integration_statuses` rows
  // that still carry `consecutive_failures_by_kind = NULL`. After
  // v1.4.47 dropped the single-column fallback, such rows alert two
  // strikes later than they did pre-upgrade. The probe is a single
  // count query + Wide-Event warning if any survive; fire-and-forget
  // so a probe failure never blocks worker boot.
  try {
    await withBackgroundEvent(
      "worker.boot.integration_status_null_probe",
      async () => {
        await probeIntegrationStatusNullBuckets(getWorkerPrisma());
      },
    );
  } catch (err) {
    workerLog("error", "integration-status-null-probe failed", err);
  }

  // v1.15.20 — retry policy for the LLM-bound insight queues. A transient
  // failure (provider hiccup, pool exhaustion) used to fail the nightly tick
  // silently until the NEXT night; three backed-off retries match the
  // backfill queues' established shape (see e.g. whoop-backfill.ts).
  const insightRetryOptions = {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  } as const;

  // Schedule recurring cron jobs. The optional third element carries
  // per-queue send options (retry policy) merged into the schedule call.
  const schedules: [string, string, Record<string, unknown>?][] = [
    [QUEUE_NAME, CHECK_INTERVAL_CRON],
    [WITHINGS_SYNC_QUEUE, WITHINGS_SYNC_CRON],
    [WITHINGS_ACTIVITY_QUEUE, WITHINGS_ACTIVITY_CRON],
    [WITHINGS_SLEEP_QUEUE, WITHINGS_SLEEP_CRON],
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
    [MOODLOG_SYNC_QUEUE, MOODLOG_SYNC_CRON],
    [DATA_BACKUP_QUEUE, DATA_BACKUP_CRON],
    [RATE_LIMIT_CLEANUP_QUEUE, RATE_LIMIT_CLEANUP_CRON],
    [IDEMPOTENCY_CLEANUP_QUEUE, IDEMPOTENCY_CLEANUP_CRON],
    [AUDIT_LOG_CLEANUP_QUEUE, AUDIT_LOG_CLEANUP_CRON],
    [WITHINGS_OAUTH_STATE_CLEANUP_QUEUE, WITHINGS_OAUTH_STATE_CLEANUP_CRON],
    // v1.11.0 — WHOOP poll-fallback crons. Recovery/sleep/workout catch
    // dropped webhooks; cycle is the sole driver (no webhook). Staggered off
    // the Withings crons so the hourly ticks don't pile up on one boss poll.
    [WHOOP_RECOVERY_SYNC_QUEUE, WHOOP_RECOVERY_SYNC_CRON],
    [WHOOP_SLEEP_SYNC_QUEUE, WHOOP_SLEEP_SYNC_CRON],
    [WHOOP_WORKOUT_SYNC_QUEUE, WHOOP_WORKOUT_SYNC_CRON],
    [WHOOP_CYCLE_SYNC_QUEUE, WHOOP_CYCLE_SYNC_CRON],
    // v1.11.0 — daily 03:22 Europe/Berlin prune for expired WHOOP OAuth states.
    [WHOOP_OAUTH_STATE_CLEANUP_QUEUE, WHOOP_OAUTH_STATE_CLEANUP_CRON],
    // v1.12.0 — hourly Fitbit poll (:08, staggered off WHOOP/Withings) + the
    // daily 03:24 Europe/Berlin prune for expired Fitbit OAuth states.
    [FITBIT_SYNC_QUEUE, FITBIT_SYNC_CRON],
    [FITBIT_OAUTH_STATE_CLEANUP_QUEUE, FITBIT_OAUTH_STATE_CLEANUP_CRON],
    // v1.17.0 — hourly Nightscout CGM poll (:11, staggered off the other sync
    // ticks).
    [NIGHTSCOUT_SYNC_QUEUE, NIGHTSCOUT_SYNC_CRON],
    // v1.17.0 (F4) — hourly Polar (:13) + Oura (:15) OAuth polls.
    [POLAR_SYNC_QUEUE, POLAR_SYNC_CRON],
    [OURA_SYNC_QUEUE, OURA_SYNC_CRON],
    [OFFHOST_BACKUP_QUEUE, OFFHOST_BACKUP_CRON],
    [RESTORE_DRILL_QUEUE, RESTORE_DRILL_CRON],
    [HOST_METRIC_QUEUE, HOST_METRIC_CRON],
    [FEEDBACK_AGGREGATOR_QUEUE, FEEDBACK_AGGREGATOR_CRON],
    // v1.4.37 — hourly geo backfill. The helper is idempotent + capped
    // at 5 000 rows per pass; running it at :40 every hour catches the
    // long tail of audit rows that landed with the offline MMDB
    // missing or the online provider unreachable.
    [GEO_BACKFILL_QUEUE, GEO_BACKFILL_CRON],
    // v1.12.2 ios-coord — every-6-hour TLS leaf SPKI probe (:07 off the
    // hourly sync crons). Surfaces a pinned-leaf rotation well inside the
    // ≥11-day re-pin window the iOS release owner needs.
    [TLS_PIN_MONITOR_QUEUE, TLS_PIN_MONITOR_CRON],
    // Fallback rescan every 30 minutes — protects against ingest paths
    // that ship measurements without enqueueing a per-user job. The
    // cron payload deliberately omits a `userId` so the handler iterates
    // every user; per-user push-suppression cannot apply on the cron
    // path (the silent flag is set by the ingest hooks).
    [PR_DETECTION_QUEUE, PR_DETECTION_FALLBACK_CRON],
    // v1.4.25 W19b — daily expire-stale pass for the per-pen inventory
    // entities. Flips IN_USE rows whose 30-day clock has blown to
    // EXPIRED at 03:30 Europe/Berlin (in the existing 02:xx–03:xx
    // maintenance window, right after idempotency-cleanup).
    [MEDICATION_INVENTORY_EXPIRE_QUEUE, MEDICATION_INVENTORY_EXPIRE_CRON],
    // v1.4.46 — hourly auto-skip for medication intakes the user never
    // marked. Cron `5 * * * *` slots off the top-of-the-hour
    // reminder-check (:00) and the moodlog-sync (:30) so the three
    // hourly ticks don't pile up on the same boss poll.
    [INTAKE_AUTO_SKIP_QUEUE, INTAKE_AUTO_SKIP_CRON],
    // v1.4.37 W7c — nightly fold of per-sample APPLE_HEALTH cumulative
    // rows into one row per day per type. Slots between the
    // audit-log cleanup (03:15) and the feedback aggregator (04:00).
    [DRAIN_CUMULATIVE_QUEUE, DRAIN_CUMULATIVE_CRON],
    // v0.5.4 ios-coord — every-15-min tick for the daily mood reminder.
    // The handler short-circuits unless the candidate user's local
    // time is the 22:00 hour, so the cron costs ~one user-row scan
    // per tick for the entire opted-in cohort.
    [MOOD_REMINDER_QUEUE, MOOD_REMINDER_CRON],
    [MOOD_REMINDER_CLEANUP_QUEUE, MOOD_REMINDER_CLEANUP_CRON],
    // v1.15 — every-15-min tick for the daily cycle reminder. The handler
    // short-circuits unless the candidate user's local time is the 09:00
    // hour, so the cron costs ~one prediction-row scan per tick for the
    // opted-in cohort.
    [CYCLE_REMINDER_QUEUE, CYCLE_REMINDER_CRON],
    // v1.4.49 — daily 03:35 Europe/Berlin prune for push_attempts.
    [PUSH_ATTEMPT_CLEANUP_QUEUE, PUSH_ATTEMPT_CLEANUP_CRON],
    // v1.7.0 — nightly 04:30 Europe/Berlin comprehensive-insight
    // pre-generation. Budget-gated per user inside the handler.
    [INSIGHT_PREGENERATE_QUEUE, INSIGHT_PREGENERATE_CRON, insightRetryOptions],
    // v1.7.0 — daily 03:40 Europe/Berlin prune for expired measurement
    // tombstones.
    [MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE, MEASUREMENT_TOMBSTONE_CLEANUP_CRON],
    // v1.15.19 — daily 03:28 Europe/Berlin duplicate dose-slot dedup
    // discovery. The empty cron payload (no `userId`) is the handler's
    // signal to run the discovery fan-out instead of a per-user pass, so
    // cross-source duplicate slots created between deploys collapse within
    // a day instead of waiting for the next worker reboot.
    [INTAKE_SLOT_DEDUP_QUEUE, INTAKE_SLOT_DEDUP_CRON],
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

  for (const [name, cron, sendOptions] of schedules) {
    await boss.schedule(
      name,
      cron,
      {},
      {
        tz: "Europe/Berlin",
        ...(sendOptions ?? {}),
      },
    );
  }

  // Register the handler
  await boss.work<ReminderCheckPayload>(
    QUEUE_NAME,
    { localConcurrency: 1 },
    handleReminderCheck,
  );
  await boss.work<WithingsSyncPayload>(
    WITHINGS_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWithingsFallbackSync,
  );
  await boss.work<WithingsActivitySyncPayload>(
    WITHINGS_ACTIVITY_QUEUE,
    { localConcurrency: 1 },
    handleWithingsActivitySync,
  );
  await boss.work<WithingsSleepSyncPayload>(
    WITHINGS_SLEEP_QUEUE,
    { localConcurrency: 1 },
    handleWithingsSleepSync,
  );
  // v1.11.0 — WHOOP per-resource sync handlers. Webhook-driven per-user +
  // cron full-iteration. Serial concurrency so a backfill-heavy tick never
  // crowds the request pool and stays inside WHOOP's 100 req/min app cap.
  await boss.work<WhoopSyncPayload>(
    WHOOP_RECOVERY_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopRecoverySync,
  );
  await boss.work<WhoopSyncPayload>(
    WHOOP_SLEEP_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopSleepSync,
  );
  await boss.work<WhoopSyncPayload>(
    WHOOP_WORKOUT_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopWorkoutSync,
  );
  await boss.work<WhoopSyncPayload>(
    WHOOP_CYCLE_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleWhoopCycleSync,
  );
  // v1.11.0 — self-converging WHOOP backfill. The boot enqueue below sends one
  // full-history sync per un-backfilled connection; this handler runs it and
  // stamps `backfillCompletedAt` so the discovery query drops the account.
  await boss.work<WhoopBackfillPayload>(
    WHOOP_BACKFILL_QUEUE,
    { localConcurrency: WHOOP_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { imported } = await runWhoopBackfillForUser(userId);
        workerLog(
          "info",
          `[whoop-backfill] user=${userId} imported=${imported}`,
        );
      }
    },
  );
  await boss.work<WhoopOAuthStateCleanupPayload>(
    WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleWhoopOAuthStateCleanup,
  );
  // v1.12.0 — Fitbit poll-sync (cron full-iteration; no webhook). Serial
  // concurrency so a backfill-heavy tick never crowds the request pool.
  await boss.work<FitbitSyncPayload>(
    FITBIT_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleFitbitSync,
  );
  // v1.12.0 — self-converging Fitbit backfill. The boot enqueue below sends one
  // full-history sync per un-backfilled connection; this handler runs it and
  // stamps `backfillCompletedAt` so the discovery query drops the account.
  await boss.work<FitbitBackfillPayload>(
    FITBIT_BACKFILL_QUEUE,
    { localConcurrency: FITBIT_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        const { imported } = await runFitbitBackfillForUser(userId);
        workerLog(
          "info",
          `[fitbit-backfill] user=${userId} imported=${imported}`,
        );
      }
    },
  );
  await boss.work<FitbitOAuthStateCleanupPayload>(
    FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleFitbitOAuthStateCleanup,
  );
  // v1.17.1 — one-shot sleep-timeline backfill. The boot enqueue below sends
  // one job per (user, provider) whose sleep rows predate the stamp/shape fix;
  // this handler deletes the affected rows, re-syncs, and stamps the marker so
  // the discovery query drops the connection.
  await boss.work<SleepTimelineBackfillPayload>(
    SLEEP_TIMELINE_BACKFILL_QUEUE,
    { localConcurrency: SLEEP_TIMELINE_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId, provider } = job.data;
        const { deleted, imported } = await runSleepTimelineBackfillForUser(
          userId,
          provider,
        );
        workerLog(
          "info",
          `[sleep-timeline-backfill] user=${userId} provider=${provider} deleted=${deleted} imported=${imported}`,
        );
      }
    },
  );
  // v1.17.0 — Nightscout CGM poll-cohort sync. The hourly cron tick (no
  // `userId`) walks every configured instance; one user's unreachable host is
  // warned, not fatal.
  await boss.work<NightscoutSyncPayload>(
    NIGHTSCOUT_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleNightscoutSync,
  );
  // v1.17.0 (F4) — Polar + Oura OAuth poll-cohort sync. The hourly cron tick
  // (no `userId`) re-walks every connected user; one user's revoked grant is
  // warned, not fatal.
  await boss.work<PolarSyncPayload>(
    POLAR_SYNC_QUEUE,
    { localConcurrency: 1 },
    handlePolarSync,
  );
  await boss.work<OuraSyncPayload>(
    OURA_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleOuraSync,
  );
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
  await boss.work<MoodLogSyncPayload>(
    MOODLOG_SYNC_QUEUE,
    { localConcurrency: 1 },
    handleMoodLogSync,
  );
  await boss.work<DataBackupPayload>(
    DATA_BACKUP_QUEUE,
    { localConcurrency: 1 },
    handleDataBackup,
  );
  await boss.work<RateLimitCleanupPayload>(
    RATE_LIMIT_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleRateLimitCleanup,
  );
  await boss.work<IdempotencyCleanupPayload>(
    IDEMPOTENCY_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleIdempotencyCleanup,
  );
  await boss.work<AuditLogCleanupPayload>(
    AUDIT_LOG_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleAuditLogCleanup,
  );
  await boss.work<WithingsOAuthStateCleanupPayload>(
    WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleWithingsOAuthStateCleanup,
  );
  await boss.work<OffhostBackupPayload>(
    OFFHOST_BACKUP_QUEUE,
    { localConcurrency: 1 },
    handleOffhostBackup,
  );
  // prettier-ignore
  await boss.work(RESTORE_DRILL_QUEUE, { localConcurrency: 1 }, handleRestoreDrill);
  await boss.work<HostMetricSamplePayload>(
    HOST_METRIC_QUEUE,
    { localConcurrency: 1 },
    handleHostMetricSample,
  );
  await boss.work<FeedbackAggregatorPayload>(
    FEEDBACK_AGGREGATOR_QUEUE,
    { localConcurrency: 1 },
    handleFeedbackAggregator,
  );
  await boss.work<GeoBackfillPayload>(
    GEO_BACKFILL_QUEUE,
    { localConcurrency: 1 },
    handleGeoBackfill,
  );
  // v1.12.2 ios-coord — TLS leaf SPKI-change monitor. Single-flight: one
  // short outbound TLS handshake per tick, no benefit to overlapping ticks.
  await boss.work<TlsPinMonitorPayload>(
    TLS_PIN_MONITOR_QUEUE,
    { localConcurrency: 1 },
    handleTlsPinMonitor,
  );
  // v0.5.4 ios-coord — single-flight worker. localConcurrency=1 keeps
  // two reminder ticks from interleaving against the same user row;
  // the dedup ledger would still save us, but skipping the race here
  // avoids spurious P2002 errors in the wide-event log.
  await boss.work<MoodReminderPayload>(
    MOOD_REMINDER_QUEUE,
    { localConcurrency: 1 },
    handleMoodReminderCheck,
  );
  await boss.work<MoodReminderCleanupPayload>(
    MOOD_REMINDER_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleMoodReminderCleanup,
  );
  // v1.15 — single-flight cycle-reminder worker. localConcurrency=1 keeps
  // two ticks from racing the fire-and-forget `push_attempts` ledger that
  // anchors the per-day idempotency, exactly like the mood-reminder worker.
  await boss.work<CycleReminderPayload>(
    CYCLE_REMINDER_QUEUE,
    { localConcurrency: 1 },
    handleCycleReminderCheck,
  );
  // v1.4.49 — daily prune of the push-attempt ledger. Single-flight
  // matches every other cleanup queue; two ticks racing on the same
  // DELETE statement is wasted work and the second tick's payload
  // would be a no-op anyway.
  await boss.work<PushAttemptCleanupPayload>(
    PUSH_ATTEMPT_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handlePushAttemptCleanup,
  );
  // v1.7.0 — daily prune of expired measurement tombstones. Single-flight
  // like every other cleanup queue.
  await boss.work<MeasurementTombstoneCleanupPayload>(
    MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleMeasurementTombstoneCleanup,
  );
  await boss.work<PrDetectionPayload>(
    PR_DETECTION_QUEUE,
    { localConcurrency: PR_DETECTION_CONCURRENCY },
    handlePrDetection,
  );
  await boss.work<MedicationInventoryExpirePayload>(
    MEDICATION_INVENTORY_EXPIRE_QUEUE,
    { localConcurrency: 1 },
    handleMedicationInventoryExpire,
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
  // v1.8.3 — on-demand per-metric status generation enqueued by the
  // read-only status route on a cold card. Low concurrency so a first
  // visit that cold-misses several cards can't saturate the Prisma pool
  // or fan out an unbounded number of concurrent provider calls.
  await boss.work<InsightStatusGeneratePayload>(
    INSIGHT_STATUS_GENERATE_QUEUE,
    { localConcurrency: INSIGHT_STATUS_GENERATE_CONCURRENCY },
    handleInsightStatusGenerate,
  );
  // v1.4.46 — hourly auto-skip for stale unmarked intakes.
  // Single-flight: two ticks racing against the same row pile is wasted
  // work, and the underlying `updateMany` is the canonical idempotent
  // shape anyway.
  await boss.work<IntakeAutoSkipPayload>(
    INTAKE_AUTO_SKIP_QUEUE,
    { localConcurrency: 1 },
    handleIntakeAutoSkip,
  );
  // v1.4.34 — Apple Health export.zip ingest worker. localConcurrency
  // caps at 1 because the parse loop is CPU-bound and a concurrent
  // second 1 GB import would race the first for RSS.
  await boss.work<AppleHealthImportPayload>(
    APPLE_HEALTH_IMPORT_QUEUE,
    { localConcurrency: APPLE_HEALTH_IMPORT_CONCURRENCY },
    async (jobs) => {
      // pg-boss v12 work callbacks always receive an array (batched
      // worker mode); for our concurrency-1 + batchSize-1 case we just
      // process each job sequentially.
      for (const job of jobs) {
        await handleAppleHealthImport(job);
      }
    },
  );

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

  // v1.8.2 — duplicate dose-slot cleanup worker. The boot enqueue helper
  // below sends one job per user holding two live intake rows that snap
  // to the same canonical slot; this handler keeps the winner, soft-
  // deletes the losers, normalises the winner's scheduledFor, and
  // recomputes the affected compliance rollups. Serial concurrency so the
  // pass never crowds the request pool.
  //
  // v1.15.19 — the queue also carries a daily cron tick (03:28, scheduled
  // above) whose payload omits `userId`. That tick runs the SAME discovery
  // fan-out the boot pass uses, so duplicate slots created between deploys
  // collapse within a day instead of waiting for the next worker reboot.
  await boss.work<Partial<IntakeSlotDedupPayload>>(
    INTAKE_SLOT_DEDUP_QUEUE,
    { localConcurrency: INTAKE_SLOT_DEDUP_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        if (!userId) {
          // Daily discovery tick — fan out one per-user job per account
          // still holding duplicate-slot candidates (singletonKey-coalesced,
          // identical to the boot pass).
          const result = await enqueueBootTimeIntakeSlotDedup();
          workerLog(
            "info",
            `[intake-slot-dedup] daily discovery enqueued=${result.enqueued} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`,
          );
          continue;
        }
        try {
          const summary = await dedupeUserIntakeSlots(userId);
          workerLog(
            "info",
            `[intake-slot-dedup] user=${userId} slotsCollapsed=${summary.slotsCollapsed} rowsSoftDeleted=${summary.rowsSoftDeleted} rowsNormalised=${summary.rowsNormalised} daysRecomputed=${summary.daysRecomputed}`,
          );
        } catch (err) {
          recordError();
          workerLog("error", `[intake-slot-dedup] user=${userId} failed`, err);
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

  // v1.4.35.1 — fire-and-forget boot-time backfill discovery. Finds
  // every user with measurements but no rollup coverage and enqueues
  // a full-fold per account. Idempotent across reboots: the discovery
  // query only matches accounts with zero rollup rows, so once a
  // fold completes the user drops off the list. Errors are returned
  // through the helper's result value — the worker boot never fails
  // because of a backfill miss.
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

  // v1.5.6 — fire-and-forget boot discovery for the legacy step
  // consolidation pass. Finds every user still holding live pre-v1.5.0
  // granular step rows and enqueues one consolidation job per account.
  // Idempotent across reboots: consolidated legacy rows are
  // soft-deleted, so the `deleted_at IS NULL` discovery predicate drops
  // them and the user falls off the list. Errors are returned through
  // the helper's result value — the worker boot never fails because of
  // a consolidation miss.
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

  // v1.11.0 — fire-and-forget boot discovery for the WHOOP backfill. Finds
  // every WHOOP connection not yet backfilled and enqueues one full-history
  // sync per account. Idempotent across reboots: a completed backfill stamps
  // `backfillCompletedAt`, dropping the connection from the discovery set.
  // Errors come back through the helper's result value — the worker boot never
  // fails because of a backfill miss.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeWhoopBackfill();
    if (error) {
      workerLog("error", `[whoop-backfill] boot discovery failed: ${error}`);
    } else {
      workerLog(
        "info",
        `[whoop-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[whoop-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.12.0 — fire-and-forget boot discovery for the Fitbit backfill. Finds
  // every Fitbit connection not yet backfilled and enqueues one full-history
  // sync per account. Idempotent across reboots: a completed backfill stamps
  // `backfillCompletedAt`, dropping the connection from the discovery set.
  // Errors come back through the helper's result value — the worker boot never
  // fails because of a backfill miss.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeFitbitBackfill();
    if (error) {
      workerLog("error", `[fitbit-backfill] boot discovery failed: ${error}`);
    } else {
      workerLog(
        "info",
        `[fitbit-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[fitbit-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.17.1 — fire-and-forget boot discovery for the one-shot sleep-timeline
  // backfill. Finds every WHOOP + Withings connection whose sleep rows predate
  // the stamp/shape fix and enqueues one job per (user, provider). Idempotent
  // across reboots: a completed pass stamps `sleepTimelineBackfillAt`, dropping
  // the connection from the discovery set. Errors come back through the
  // helper's result value — the worker boot never fails because of a miss.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeSleepTimelineBackfill();
    if (error) {
      workerLog(
        "error",
        `[sleep-timeline-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[sleep-timeline-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[sleep-timeline-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.7.0 — fire-and-forget boot discovery for the daily-mean
  // consolidation pass. Finds every user holding live per-sample
  // high-frequency mean-type rows and enqueues one job per account.
  // Idempotent across reboots: consolidated rows are soft-deleted, so
  // the discovery predicate drops them. Errors are returned through the
  // helper's result value — the worker boot never fails on a miss.
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

  // v1.10.0 WX-E — fire-and-forget boot discovery for the dense intra-day
  // retention drain. Finds every user holding live per-sample dense-tier
  // (HRV / HR) rows OLDER than the retention window and enqueues one job per
  // account. Idempotent across reboots: folded rows are soft-deleted, so the
  // discovery predicate drops them. Errors are returned through the helper's
  // result value — the worker boot never fails on a miss.
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

  // v1.8.2 — fire-and-forget boot discovery for the duplicate dose-slot
  // cleanup. Finds every user holding two live intake rows within the
  // drift window on the same medication and enqueues one dedup job per
  // account. Idempotent across reboots: collapsed losers are soft-deleted
  // so the `deleted_at IS NULL` discovery predicate drops them. Errors are
  // returned through the helper's result value — the worker boot never
  // fails because of a dedup miss.
  try {
    const { enqueued, skipped, error } = await enqueueBootTimeIntakeSlotDedup();
    if (error) {
      workerLog("error", `[intake-slot-dedup] boot discovery failed: ${error}`);
    } else {
      workerLog(
        "info",
        `[intake-slot-dedup] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[intake-slot-dedup] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MOOD — fire-and-forget boot discovery for the mood
  // rollup tier. Mirrors the v1.4.35.1 measurement-rollup pattern:
  // one job per user with mood entries but no rollup coverage.
  // Idempotent across reboots and singleton-keyed inside pg-boss so
  // a fast restart while a backfill is queued doesn't double up.
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

  // v1.4.39 W-MED — fire-and-forget boot discovery for the medication
  // compliance rollup tier. Mirrors the v1.4.35.1 pattern: one job per
  // user with intake events but no rollup coverage. Idempotent across
  // reboots and singleton-keyed inside pg-boss.
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

  return boss;
}

// Run standalone
if (
  process.argv[1]?.endsWith("reminder-worker.ts") ||
  process.argv[1]?.endsWith("reminder-worker.js")
) {
  startReminderWorker().catch((err) => {
    workerLog("error", "Failed to start reminder worker", err);
    process.exit(1);
  });
}
