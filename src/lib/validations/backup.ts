/**
 * Zod schemas + helpers for the per-user `DataBackup` JSON payload.
 *
 * Single source of truth shared by:
 *   - the pg-boss `data-backup` worker that writes a backup,
 *   - `GET /api/admin/backups/[id]/download` that streams it back as JSON,
 *   - `POST /api/admin/backups/upload` that ingests an admin-supplied file,
 *   - `POST /api/admin/backups/[id]/restore` that re-creates DB rows from it.
 *
 * The schema is intentionally permissive about *extra* fields (`.passthrough`)
 * so older snapshots written before a column was added still parse and so
 * future minor additions don't break old admins. Required fields are
 * deliberately tight — any drift surfaces as a validation error rather than
 * a silent data-loss restore.
 *
 * `schemaVersion` is the migration handle. Bump when the on-disk shape
 * changes incompatibly. The current writer (worker) historically did NOT
 * include this field; `parseBackupPayload()` defaults it to "1" so legacy
 * blobs continue to round-trip and the upload validator can still produce
 * a useful summary for them.
 */
import { z } from "zod/v4";

export const BACKUP_SCHEMA_VERSION = "1" as const;

const isoDateTime = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "Expected ISO-8601 date-time string",
  });

const measurementSchema = z
  .object({
    type: z.string().min(1),
    value: z.number(),
    unit: z.string().min(1),
    measuredAt: isoDateTime,
    source: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();

const medicationScheduleSchema = z
  .object({
    windowStart: z.string().min(1),
    windowEnd: z.string().min(1),
    label: z.string().nullable().optional(),
    dose: z.string().nullable().optional(),
  })
  .passthrough();

const medicationSchema = z
  .object({
    name: z.string().min(1),
    dose: z.string(),
    active: z.boolean().optional(),
    schedules: z.array(medicationScheduleSchema).default([]),
  })
  .passthrough();

const intakeEventSchema = z
  .object({
    medication: z.string().min(1),
    scheduledFor: isoDateTime,
    takenAt: isoDateTime.nullable().optional(),
    skipped: z.boolean().optional(),
    source: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * `MoodEntry.tags` is stored as a JSON-array-as-string in the
 * `mood_entries.tags` column ("[\"work\",\"sleep\"]"). The previous
 * schema accepted any `string` here, so a malformed blob in a backup
 * (or one tampered with mid-restore) would land in the DB and crash
 * downstream readers that `JSON.parse` it. We now refine to one of
 * `null` / empty-string (legacy null wire format) / a JSON string
 * that parses to a `string[]`. v1.4.15 H2.
 */
const moodEntryTagsSchema = z
  .union([z.null(), z.string()])
  .nullable()
  .optional()
  .refine(
    (v) => {
      if (v == null || v === "") return true;
      try {
        const parsed = JSON.parse(v) as unknown;
        return (
          Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
        );
      } catch {
        return false;
      }
    },
    { message: "tags must be null, empty, or a JSON array of strings" },
  );

const moodEntrySchema = z
  .object({
    date: z.string().min(1),
    mood: z.string().min(1),
    score: z.number().int().min(0).max(10),
    tags: moodEntryTagsSchema,
    source: z.string().min(1).optional(),
    loggedAt: isoDateTime,
  })
  .passthrough();

/* ── v1.15.0 cycle-tracking backup shapes ──────────────────────────── */

/**
 * One menstrual-cycle span. `startDate` is the natural per-user key
 * (matching the `(userId, startDate)` unique), so a restore upserts on it.
 * Predicted (forecast) rows are excluded from the backup — only observed
 * history round-trips.
 */
const cycleSpanSchema = z
  .object({
    startDate: z.string().min(1),
    endDate: z.string().nullable().optional(),
    periodEndDate: z.string().nullable().optional(),
    lengthDays: z.number().int().nullable().optional(),
    ovulationDate: z.string().nullable().optional(),
    ovulationConfirmed: z.boolean().optional(),
    tz: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * One cycle day-log. `notesEncrypted` is carried as the AES-256-GCM
 * ciphertext envelope verbatim — the backup never decrypts it, so the
 * owner's free-text note round-trips encrypted (and a wrong-surface leak is
 * impossible). `symptomKeys` carries the seeded catalogue keys so the
 * restore can re-link without exporting internal join ids.
 */
const cycleDayLogSchema = z
  .object({
    date: z.string().min(1),
    flow: z.string().nullable().optional(),
    intermenstrualBleeding: z.boolean().optional(),
    basalBodyTempC: z.number().nullable().optional(),
    ovulationTest: z.string().nullable().optional(),
    cervicalMucus: z.string().nullable().optional(),
    sexualActivity: z.boolean().optional(),
    protectedSex: z.boolean().nullable().optional(),
    pregnancyTest: z.string().nullable().optional(),
    progesteroneTest: z.string().nullable().optional(),
    contraceptive: z.string().nullable().optional(),
    notesEncrypted: z.string().nullable().optional(),
    source: z.string().min(1).optional(),
    externalId: z.string().nullable().optional(),
    tz: z.string().nullable().optional(),
    symptomKeys: z.array(z.string()).default([]),
  })
  .passthrough();

/** Cycle-tracking preferences (one row per user). */
const cycleProfileSchema = z
  .object({
    goal: z.string().min(1).optional(),
    cycleTrackingEnabled: z.boolean().nullable().optional(),
    typicalCycleLength: z.number().int().nullable().optional(),
    typicalPeriodLength: z.number().int().nullable().optional(),
    lutealPhaseLength: z.number().int().nullable().optional(),
    predictionEnabled: z.boolean().optional(),
    rawChartMode: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
  })
  .passthrough();

/**
 * Wire shape — exactly what the pg-boss worker writes today, plus a
 * `schemaVersion` field that newer writers stamp explicitly. Older blobs
 * without the field default to v1 in `parseBackupPayload`.
 */
export const backupPayloadSchema = z
  .object({
    schemaVersion: z.string().min(1).default(BACKUP_SCHEMA_VERSION),
    exportedAt: isoDateTime,
    userId: z.string().min(1),
    measurements: z.array(measurementSchema).default([]),
    medications: z.array(medicationSchema).default([]),
    intakeEvents: z.array(intakeEventSchema).default([]),
    moodEntries: z.array(moodEntrySchema).default([]),
    // v1.15.0 — cycle-tracking tables. Default to empty arrays / null so a
    // pre-v1.15 backup (no cycle keys) still round-trips unchanged.
    cycleProfile: cycleProfileSchema.nullable().default(null),
    cycles: z.array(cycleSpanSchema).default([]),
    cycleDayLogs: z.array(cycleDayLogSchema).default([]),
  })
  .passthrough();

export type BackupPayload = z.infer<typeof backupPayloadSchema>;

/**
 * Numeric counts of each backed-up record kind. Returned in the
 * upload + restore API responses so the admin sees what they
 * uploaded/restored without having to download the file again.
 */
export interface BackupSummary {
  schemaVersion: string;
  userId: string;
  exportedAt: string;
  measurements: number;
  medications: number;
  intakeEvents: number;
  moodEntries: number;
  /** v1.15.0 — observed cycle spans in the backup. */
  cycles: number;
  /** v1.15.0 — cycle day-logs in the backup. */
  cycleDayLogs: number;
}

export function summarizeBackup(payload: BackupPayload): BackupSummary {
  return {
    schemaVersion: payload.schemaVersion,
    userId: payload.userId,
    exportedAt: payload.exportedAt,
    measurements: payload.measurements.length,
    medications: payload.medications.length,
    intakeEvents: payload.intakeEvents.length,
    moodEntries: payload.moodEntries.length,
    cycles: payload.cycles.length,
    cycleDayLogs: payload.cycleDayLogs.length,
  };
}

/**
 * Parse a JSON blob (string or already-parsed object) against
 * `backupPayloadSchema`, returning a typed payload. Throws ZodError on
 * mismatch — the admin route catches it and turns it into a 422 with a
 * field-level error list.
 *
 * Accepts both forms because:
 *   - the upload route hands us the parsed object after `await req.text()`
 *   - the restore route reads `DataBackup.data` (decrypted) which is
 *     always a JSON string straight from the worker.
 */
export function parseBackupPayload(input: string | unknown): BackupPayload {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  return backupPayloadSchema.parse(raw);
}

/**
 * The schemaVersion the system understands today. Used by the upload
 * route to reject inbound files written by a *future* HealthLog instance
 * — restoring them under the current code might silently drop data the
 * new shape carried.
 */
export function isCompatibleSchemaVersion(version: string): boolean {
  return version === BACKUP_SCHEMA_VERSION;
}
