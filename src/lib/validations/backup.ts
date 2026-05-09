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

const moodEntrySchema = z
  .object({
    date: z.string().min(1),
    mood: z.string().min(1),
    score: z.number().int().min(0).max(10),
    tags: z.string().nullable().optional(),
    source: z.string().min(1).optional(),
    loggedAt: isoDateTime,
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
