/**
 * Maintenance / ops / cleanup queue registrar.
 *
 * Owns the housekeeping tier: data backup (in-DB weekly + off-host nightly),
 * the restore drill, every ledger cleanup (rate-limit, idempotency, audit-log,
 * mood-reminder, push-attempt, measurement-tombstone), medication inventory
 * expiry, intake auto-skip, the duplicate dose-slot dedup (boot + daily-cron),
 * host-metric sampling, the rec-feedback aggregator, the geo backfill, the TLS
 * pin monitor, PR detection, and the Apple Health export ingest.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `boss.work(QUEUE, …, handler)` binding drains it. The
 * `measurement-tombstone-cleanup`, `withings-oauth-state-cleanup`,
 * `intake-slot-dedup-queue`, `tls-pin-monitor-queue`, and `geo-backfill`
 * guards read THIS module.
 */
import { PgBoss } from "pg-boss";
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
  INTAKE_AUTO_SKIP_QUEUE,
  INTAKE_AUTO_SKIP_CRON,
  type IntakeAutoSkipPayload,
} from "@/lib/jobs/intake-auto-skip";
import {
  APPLE_HEALTH_IMPORT_QUEUE,
  APPLE_HEALTH_IMPORT_CONCURRENCY,
  handleAppleHealthImport,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import {
  INTAKE_SLOT_DEDUP_QUEUE,
  INTAKE_SLOT_DEDUP_CONCURRENCY,
  dedupeUserIntakeSlots,
  enqueueBootTimeIntakeSlotDedup,
  type IntakeSlotDedupPayload,
} from "@/lib/medications/intake-slot-dedup";
import {
  handleRestoreDrill,
  RESTORE_DRILL_CRON,
  RESTORE_DRILL_QUEUE,
} from "@/lib/jobs/restore-drill";
import {
  NOTE_ENCRYPTION_BACKFILL_QUEUE,
  NOTE_ENCRYPTION_BACKFILL_CONCURRENCY,
  runNoteEncryptionBackfillForUser,
  enqueueBootTimeNoteEncryptionBackfill,
  type NoteEncryptionBackfillPayload,
} from "@/lib/jobs/note-encryption-backfill";
import {
  ENCRYPTION_KEY_ROTATE_QUEUE,
  ENCRYPTION_KEY_ROTATE_CONCURRENCY,
  handleEncryptionKeyRotate,
  type EncryptionKeyRotatePayload,
} from "@/lib/jobs/encryption-key-rotate";
import { recordError } from "@/lib/jobs/worker-status";
import { workerLog } from "./shared";
import { createAndSchedule, type ScheduleEntry } from "./registrar-shared";
import {
  DataBackupPayload,
  OffhostBackupPayload,
  handleOffhostBackup,
  handleDataBackup,
} from "./backup-handlers";
import {
  RateLimitCleanupPayload,
  IdempotencyCleanupPayload,
  AuditLogCleanupPayload,
  MoodReminderCleanupPayload,
  handleMoodReminderCleanup,
  PushAttemptCleanupPayload,
  handlePushAttemptCleanup,
  MeasurementTombstoneCleanupPayload,
  handleMeasurementTombstoneCleanup,
  handleRateLimitCleanup,
  handleIdempotencyCleanup,
  handleAuditLogCleanup,
  CoachMessageCleanupPayload,
  handleCoachMessageCleanup,
} from "./cleanup-handlers";
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
} from "./ops-handlers";
import {
  handleMedicationInventoryExpire,
  handleIntakeAutoSkip,
} from "./medication-maintenance";

const DATA_BACKUP_QUEUE = "data-backup";

const DATA_BACKUP_CRON = "0 3 * * 0"; // weekly Sunday at 03:00

const RATE_LIMIT_CLEANUP_QUEUE = "rate-limit-cleanup";

const RATE_LIMIT_CLEANUP_CRON = "*/5 * * * *"; // every 5 minutes

const IDEMPOTENCY_CLEANUP_QUEUE = "idempotency-cleanup";

const IDEMPOTENCY_CLEANUP_CRON = "0 3 * * *"; // daily at 03:00 (Europe/Berlin)

const AUDIT_LOG_CLEANUP_QUEUE = "audit-log-cleanup";

const AUDIT_LOG_CLEANUP_CRON = "15 3 * * *"; // daily at 03:15 (Europe/Berlin)
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
// v0.5.4 ios-coord — daily mood-reminder dispatch-ledger retention sweep.
// Rows older than 90 days are behavioural footprints of mood-log gaps; we
// keep them long enough to debug a duplicate-push report (~one billing
// cycle) but no longer. Slots between the audit-log cleanup (03:15) and the
// drain (03:45).

const MOOD_REMINDER_CLEANUP_QUEUE = "mood-reminder-cleanup";

const MOOD_REMINDER_CLEANUP_CRON = "25 3 * * *";

const PUSH_ATTEMPT_CLEANUP_QUEUE = "push-attempt-cleanup";

const PUSH_ATTEMPT_CLEANUP_CRON = "35 3 * * *";

const MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE = "measurement-tombstone-cleanup";

const MEASUREMENT_TOMBSTONE_CLEANUP_CRON = "40 3 * * *";
// v1.18.7 — daily prune for the encrypted Coach conversation history.
// coach_messages is append-only and grows forever; rows older than the
// configurable retention window (default 365 days) are hard-deleted.
// Slots at 03:50 Europe/Berlin after the measurement-tombstone cleanup
// (03:40) and the cumulative drain (03:45), staying inside the existing
// 03:xx maintenance window.

const COACH_MESSAGE_CLEANUP_QUEUE = "coach-message-cleanup";

const COACH_MESSAGE_CLEANUP_CRON = "50 3 * * *";
// v1.23 — converging backfill that migrates the free-text health-note columns
// (mood + measurement) from plaintext to AES-256-GCM at rest. Boot discovery
// enqueues one per-user job; a daily 03:55 Europe/Berlin discovery tick (empty
// payload) re-fans for any rows that landed between worker reboots, so the
// migration converges without a restart. Idempotent + fail-closed per row.

const NOTE_ENCRYPTION_BACKFILL_CRON = "55 3 * * *";

const allQueues = [
  DATA_BACKUP_QUEUE,
  RATE_LIMIT_CLEANUP_QUEUE,
  IDEMPOTENCY_CLEANUP_QUEUE,
  AUDIT_LOG_CLEANUP_QUEUE,
  OFFHOST_BACKUP_QUEUE,
  RESTORE_DRILL_QUEUE,
  HOST_METRIC_QUEUE,
  FEEDBACK_AGGREGATOR_QUEUE,
  GEO_BACKFILL_QUEUE,
  // v1.12.2 ios-coord — TLS leaf SPKI-change monitor. The iOS client
  // pins the served leaf certificate; this queue probes it every 6 h and
  // alarms when the served SPKI leaves the operator's known-good set.
  TLS_PIN_MONITOR_QUEUE,
  PR_DETECTION_QUEUE,
  MEDICATION_INVENTORY_EXPIRE_QUEUE,
  // v1.4.46 — hourly auto-skip pass for stale unmarked intakes. Without
  // this entry the schedule silently no-ops and pending rows older than
  // 24 h pile up unflipped.
  INTAKE_AUTO_SKIP_QUEUE,
  APPLE_HEALTH_IMPORT_QUEUE,
  // v1.8.2 — one-time duplicate dose-slot cleanup. Boot discovery enqueues
  // one job per user holding two live intake rows that snap to the same
  // canonical slot (the pre-fix REMINDER-pending + API-taken pair). Also
  // carries a daily discovery cron (03:28). Without this entry pg-boss never
  // provisions it and both the boot enqueue and the cron silently no-op.
  INTAKE_SLOT_DEDUP_QUEUE,
  // v0.5.4 ios-coord — mood-reminder dispatch-ledger retention sweep.
  MOOD_REMINDER_CLEANUP_QUEUE,
  // v1.4.49 — push-attempt ledger cleanup. The daily schedule below would
  // silently no-op without this entry.
  PUSH_ATTEMPT_CLEANUP_QUEUE,
  // v1.7.0 — soft-deleted measurement tombstone prune. Without this entry
  // the daily schedule silently no-ops and pruned-past-retention tombstones
  // pile up forever.
  MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,
  // v1.18.7 — Coach conversation-history retention prune. Without this entry
  // the daily schedule silently no-ops and the encrypted coach_messages
  // table grows unbounded.
  COACH_MESSAGE_CLEANUP_QUEUE,
  // v1.23 — free-text health-note encryption backfill. Boot discovery + a
  // daily discovery cron enqueue one per-user job per account still holding a
  // plaintext note; without this entry pg-boss never provisions the queue and
  // both the boot enqueue and the cron silently no-op.
  NOTE_ENCRYPTION_BACKFILL_QUEUE,
  // v1.23 — admin-triggered encryption-key rotation. On-demand only (no
  // cron): the admin panel enqueues a singleton run that re-encrypts the
  // corpus to the active key. Without this entry pg-boss never provisions the
  // queue and the admin trigger silently no-ops.
  ENCRYPTION_KEY_ROTATE_QUEUE,
];

const schedules: ScheduleEntry[] = [
  [DATA_BACKUP_QUEUE, DATA_BACKUP_CRON],
  [RATE_LIMIT_CLEANUP_QUEUE, RATE_LIMIT_CLEANUP_CRON],
  [IDEMPOTENCY_CLEANUP_QUEUE, IDEMPOTENCY_CLEANUP_CRON],
  [AUDIT_LOG_CLEANUP_QUEUE, AUDIT_LOG_CLEANUP_CRON],
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
  // v0.5.4 ios-coord — daily mood-reminder dispatch-ledger retention sweep.
  [MOOD_REMINDER_CLEANUP_QUEUE, MOOD_REMINDER_CLEANUP_CRON],
  // v1.15.19 — daily 03:28 Europe/Berlin duplicate dose-slot dedup
  // discovery. The empty cron payload (no `userId`) is the handler's
  // signal to run the discovery fan-out instead of a per-user pass, so
  // cross-source duplicate slots created between deploys collapse within
  // a day instead of waiting for the next worker reboot.
  [INTAKE_SLOT_DEDUP_QUEUE, INTAKE_SLOT_DEDUP_CRON],
  // v1.4.49 — daily 03:35 Europe/Berlin prune for push_attempts.
  [PUSH_ATTEMPT_CLEANUP_QUEUE, PUSH_ATTEMPT_CLEANUP_CRON],
  // v1.7.0 — daily 03:40 Europe/Berlin prune for expired measurement
  // tombstones.
  [MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE, MEASUREMENT_TOMBSTONE_CLEANUP_CRON],
  // v1.18.7 — daily 03:50 Europe/Berlin prune for stale Coach history.
  [COACH_MESSAGE_CLEANUP_QUEUE, COACH_MESSAGE_CLEANUP_CRON],
  // v1.23 — daily 03:55 Europe/Berlin note-encryption backfill discovery.
  // The empty cron payload (no `userId`) is the handler's signal to fan out
  // one per-user job per account still holding a plaintext note.
  [NOTE_ENCRYPTION_BACKFILL_QUEUE, NOTE_ENCRYPTION_BACKFILL_CRON],
];

/**
 * Register every maintenance / ops / cleanup queue. Returns the queue names
 * created (for the boot-level aggregate assertion).
 */
export async function registerMaintenanceQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules);

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
  await boss.work<MoodReminderCleanupPayload>(
    MOOD_REMINDER_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleMoodReminderCleanup,
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
  // v1.18.7 — daily prune of the encrypted Coach conversation history.
  // Single-flight like every other cleanup queue; two ticks racing on the
  // same DELETE is wasted work and the second is a no-op.
  await boss.work<CoachMessageCleanupPayload>(
    COACH_MESSAGE_CLEANUP_QUEUE,
    { localConcurrency: 1 },
    handleCoachMessageCleanup,
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

  // v1.23 — note-encryption backfill worker. The boot enqueue helper (and the
  // daily 03:55 discovery tick) send one job per user still holding a plaintext
  // note; this handler migrates that user's rows to the encrypted columns. An
  // empty-userId payload is the daily discovery tick and re-fans the per-user
  // jobs (singletonKey-coalesced, identical to the boot pass). Serial
  // concurrency so the migration never crowds the request pool.
  await boss.work<Partial<NoteEncryptionBackfillPayload>>(
    NOTE_ENCRYPTION_BACKFILL_QUEUE,
    { localConcurrency: NOTE_ENCRYPTION_BACKFILL_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const { userId } = job.data;
        if (!userId) {
          const result = await enqueueBootTimeNoteEncryptionBackfill();
          workerLog(
            "info",
            `[note-encryption-backfill] daily discovery enqueued=${result.enqueued} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`,
          );
          continue;
        }
        try {
          const { measurementsMigrated, moodEntriesMigrated } =
            await runNoteEncryptionBackfillForUser(userId);
          workerLog(
            "info",
            `[note-encryption-backfill] user=${userId} measurements=${measurementsMigrated} moodEntries=${moodEntriesMigrated}`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[note-encryption-backfill] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
    },
  );

  // v1.23 — admin-triggered encryption-key rotation (on-demand, singleton).
  await boss.work<EncryptionKeyRotatePayload>(
    ENCRYPTION_KEY_ROTATE_QUEUE,
    { localConcurrency: ENCRYPTION_KEY_ROTATE_CONCURRENCY },
    handleEncryptionKeyRotate,
  );

  return allQueues;
}

/**
 * Fire-and-forget boot discovery for the duplicate dose-slot cleanup. Finds
 * every user holding two live intake rows within the drift window on the same
 * medication and enqueues one dedup job per account. Idempotent across reboots:
 * collapsed losers are soft-deleted so the `deleted_at IS NULL` discovery
 * predicate drops them. Errors are returned through the helper's result value —
 * the worker boot never fails because of a dedup miss.
 */
export async function enqueueMaintenanceBootDiscovery(): Promise<void> {
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

  // v1.23 — note-encryption backfill. Finds every user still holding a
  // plaintext mood/measurement note (no ciphertext yet) and enqueues one
  // migration job per account. Idempotent across reboots: a migrated row nulls
  // its plaintext column and drops off the discovery predicate.
  try {
    const { enqueued, skipped, error } =
      await enqueueBootTimeNoteEncryptionBackfill();
    if (error) {
      workerLog(
        "error",
        `[note-encryption-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[note-encryption-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[note-encryption-backfill] boot discovery threw an unexpected error",
      err,
    );
  }
}
