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
    temperatureExcluded: z.boolean().optional(),
    ovulationTest: z.string().nullable().optional(),
    cervicalMucus: z.string().nullable().optional(),
    cervixPosition: z.string().nullable().optional(),
    cervixFirmness: z.string().nullable().optional(),
    cervixOpening: z.string().nullable().optional(),
    sexualActivity: z.boolean().optional(),
    protectedSex: z.boolean().nullable().optional(),
    pregnancyTest: z.string().nullable().optional(),
    progesteroneTest: z.string().nullable().optional(),
    contraceptive: z.string().nullable().optional(),
    sensitiveEncrypted: z.string().nullable().optional(),
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
    secondarySymptom: z.string().nullable().optional(),
    predictionEnabled: z.boolean().optional(),
    rawChartMode: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
  })
  .passthrough();

/* ── v1.28 backup-completeness shapes ──────────────────────────────
 *
 * Labs, illness episodes (+ flares/exacerbations), allergies, family
 * history, workouts, and the documents manifest. Written by
 * `buildRecordsBackupSection` (`src/lib/export/records-backup.ts`) — shared
 * by the on-demand export routes AND the weekly `data-backup` worker.
 *
 * EXPORT-ONLY today: `POST /api/admin/backups/[id]/restore` does not yet
 * recreate these domains on restore (only measurements / medications /
 * mood / cycle round-trip). The schemas below exist so the payload
 * validates + parses with real types (an admin reviewing an uploaded
 * backup sees accurate counts) even though restore ignores them for now.
 */

const labResultBackupSchema = z
  .object({
    panel: z.string().nullable().optional(),
    analyte: z.string().min(1),
    value: z.number().nullable().optional(),
    valueText: z.string().nullable().optional(),
    unit: z.string().min(1),
    referenceLow: z.number().nullable().optional(),
    referenceHigh: z.number().nullable().optional(),
    takenAt: isoDateTime,
    source: z.string().min(1),
    biomarkerName: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .passthrough();

const biomarkerBackupSchema = z
  .object({
    name: z.string().min(1),
    unit: z.string().min(1),
    lowerBound: z.number().nullable().optional(),
    upperBound: z.number().nullable().optional(),
    panel: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
    context: z.string().nullable().optional(),
  })
  .passthrough();

const illnessSymptomBackupSchema = z
  .object({
    key: z.string().min(1),
    severity: z.number().int().nullable().optional(),
  })
  .passthrough();

const illnessDayLogBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    episodeId: z.string().min(1).optional(),
    date: z.string().min(1),
    functionalImpact: z.number().int().nullable().optional(),
    feverC: z.number().nullable().optional(),
    symptoms: z.array(illnessSymptomBackupSchema).default([]),
    note: z.string().nullable().optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const illnessEpisodeBackupSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.string().min(1),
    lifecycle: z.string().min(1),
    onsetAt: isoDateTime,
    resolvedAt: isoDateTime.nullable().optional(),
    // Self-referencing flare/exacerbation link, carried as the exported
    // episode's own id — never resolved against another user's rows.
    parentConditionId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    dayLogs: z.array(illnessDayLogBackupSchema).default([]),
  })
  .passthrough();

const allergyBackupSchema = z
  .object({
    id: z.string().min(1),
    substance: z.string().min(1),
    category: z.string().min(1),
    type: z.string().min(1),
    severity: z.string().nullable().optional(),
    status: z.string().min(1),
    onsetAt: isoDateTime.nullable().optional(),
    reaction: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const familyHistoryBackupSchema = z
  .object({
    id: z.string().min(1),
    relationship: z.string().min(1),
    condition: z.string().min(1),
    ageAtOnset: z.number().int().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();

const workoutBackupSchema = z
  .object({
    sportType: z.string().min(1),
    startedAt: isoDateTime,
    endedAt: isoDateTime,
    durationSec: z.number().int(),
    totalEnergyKcal: z.number().nullable().optional(),
    totalDistanceM: z.number().nullable().optional(),
    avgHeartRate: z.number().int().nullable().optional(),
    maxHeartRate: z.number().int().nullable().optional(),
    minHeartRate: z.number().int().nullable().optional(),
    stepCount: z.number().int().nullable().optional(),
    elevationM: z.number().nullable().optional(),
    pauseDurationSec: z.number().int().nullable().optional(),
    source: z.string().min(1),
    externalId: z.string().nullable().optional(),
  })
  .passthrough();

const documentBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    mimeType: z.string().min(1),
    byteSize: z.number().int(),
    status: z.string().min(1),
    reportDate: z.string().nullable().optional(),
    documentDate: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();

const backupManifestSchema = z
  .object({
    documents: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
    workouts: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
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
    // v1.28 backup-completeness — export-only for now (see the block
    // comment above). Default to empty arrays / null so a pre-v1.28 backup
    // (no records keys) still round-trips unchanged.
    labResults: z.array(labResultBackupSchema).default([]),
    biomarkers: z.array(biomarkerBackupSchema).default([]),
    illnessEpisodes: z.array(illnessEpisodeBackupSchema).default([]),
    allergies: z.array(allergyBackupSchema).default([]),
    familyHistory: z.array(familyHistoryBackupSchema).default([]),
    workouts: z.array(workoutBackupSchema).default([]),
    documents: z.array(documentBackupSchema).default([]),
    manifest: backupManifestSchema.nullable().default(null),
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
  /** v1.28 — lab results in the backup (export-only, see above). */
  labResults: number;
  /** v1.28 — biomarker catalog entries in the backup (export-only). */
  biomarkers: number;
  /** v1.28 — illness episodes, incl. flares/exacerbations (export-only). */
  illnessEpisodes: number;
  /** v1.28 — illness day-logs across every episode (export-only). */
  illnessDayLogs: number;
  /** v1.28 — allergy/intolerance records in the backup (export-only). */
  allergies: number;
  /** v1.28 — family-history entries in the backup (export-only). */
  familyHistory: number;
  /** v1.28 — workout summary records in the backup (export-only). */
  workouts: number;
  /** v1.28 — document manifest entries (metadata only, export-only). */
  documents: number;
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
    labResults: payload.labResults.length,
    biomarkers: payload.biomarkers.length,
    illnessEpisodes: payload.illnessEpisodes.length,
    illnessDayLogs: payload.illnessEpisodes.reduce(
      (sum, e) => sum + e.dayLogs.length,
      0,
    ),
    allergies: payload.allergies.length,
    familyHistory: payload.familyHistory.length,
    workouts: payload.workouts.length,
    documents: payload.documents.length,
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
