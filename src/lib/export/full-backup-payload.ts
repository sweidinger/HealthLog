/**
 * v1.23 — shared builder for the user-scoped full-backup payload.
 *
 * Extracted so both the plaintext `GET /api/export/full-backup` route and the
 * passphrase-encrypted `POST /api/export/encrypted` route emit the byte-for-byte
 * same shape — the one that the pg-boss `data-backup` worker writes and that
 * `parseBackupPayload()` round-trips on admin restore. Keep this writer in sync
 * with the `data-backup` worker (`src/lib/jobs/reminder-worker.ts`).
 *
 * The decrypted notes are surfaced here (the backup is the human-readable
 * artefact); an admin restore re-encrypts them on re-insert.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { readNote } from "@/lib/crypto/note-cipher";
import { findMeasurementsPaged } from "@/lib/export/paged-measurements";
import { BACKUP_SCHEMA_VERSION } from "@/lib/validations/backup";
import { buildCycleBackupSection } from "@/lib/cycle/backup";
import {
  buildRecordsBackupSection,
  countRecordsBackupSection,
  type RecordsBackupCounts,
} from "@/lib/export/records-backup";

export interface FullBackupCounts extends RecordsBackupCounts {
  measurements: number;
  medications: number;
  intakeEvents: number;
  moodEntries: number;
  cycles: number;
  cycleDayLogs: number;
  nutrientDays: number;
}

export interface FullBackupResult {
  payload: Record<string, unknown>;
  counts: FullBackupCounts;
}

/**
 * Build the canonical full-backup payload for `userId`. Soft-deleted rows are
 * excluded so a round-trip via admin restore never resurrects deleted records.
 */
export async function buildFullBackupPayload(
  prisma: PrismaClient,
  userId: string,
): Promise<FullBackupResult> {
  const [
    measurements,
    medications,
    intakeEvents,
    moodEntries,
    cycle,
    records,
    nutrientDays,
  ] = await Promise.all([
    // v1.28.25 — keyset-paginated read with a narrow select. The backup
    // is inherently whole-history, so on a CGM / per-sample-HR account the
    // previous single full-width `findMany` materialised a six-figure row
    // set in one shot. The chunked read accumulates the same rows in the
    // same `measuredAt desc` order; the payload FORMAT below is untouched
    // (restore compatibility). The select is exactly the fields the
    // serializer reads: type / value / unit / measuredAt / source + the
    // note columns `readNote` decrypts + the `id` cursor key.
    findMeasurementsPaged(
      prisma,
      { userId, deletedAt: null },
      {
        id: true,
        type: true,
        value: true,
        unit: true,
        measuredAt: true,
        source: true,
        notes: true,
        notesEncrypted: true,
      },
    ),
    prisma.medication.findMany({
      where: { userId },
      select: {
        name: true,
        dose: true,
        active: true,
        schedules: {
          select: {
            windowStart: true,
            windowEnd: true,
            label: true,
            dose: true,
          },
        },
      },
    }),
    prisma.medicationIntakeEvent.findMany({
      where: { userId, deletedAt: null },
      include: { medication: { select: { name: true } } },
      orderBy: { scheduledFor: "desc" },
    }),
    prisma.moodEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
    }),
    buildCycleBackupSection(prisma, userId),
    buildRecordsBackupSection(prisma, userId),
    // Nutrient day totals were absent from every export path, which
    // contradicted the schema's own justification for denormalising the unit
    // column ("rows stay self-describing in exports even if the catalog ever
    // drifts"). `source` is part of the composite PK, so it has to ride along
    // or a restore cannot tell a manual water entry from a synced day total.
    prisma.nutrientIntakeDay.findMany({
      where: { userId },
      select: {
        day: true,
        nutrient: true,
        amount: true,
        unit: true,
        source: true,
      },
      orderBy: [{ day: "desc" }, { nutrient: "asc" }],
    }),
  ]);

  const payload = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    userId,
    measurements: measurements.map((m) => ({
      type: m.type,
      value: m.value,
      unit: m.unit,
      measuredAt: m.measuredAt.toISOString(),
      source: m.source,
      notes: readNote(m.notesEncrypted, m.notes),
    })),
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      active: m.active,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
        dose: s.dose,
      })),
    })),
    intakeEvents: intakeEvents.map((e) => ({
      medication: e.medication.name,
      scheduledFor: e.scheduledFor.toISOString(),
      takenAt: e.takenAt?.toISOString() ?? null,
      skipped: e.skipped,
      source: e.source,
    })),
    moodEntries: moodEntries.map((e) => ({
      date: e.date,
      mood: e.mood,
      score: e.score,
      tags: e.tags,
      source: e.source,
      loggedAt: e.moodLoggedAt.toISOString(),
    })),
    cycleProfile: cycle.cycleProfile,
    cycles: cycle.cycles,
    cycleDayLogs: cycle.cycleDayLogs,
    // v1.28 backup-completeness — the domains the pre-existing shape never
    // covered. `manifest` discloses the two deliberate exclusions (document
    // binaries, workout GPS/sample time series) inline in the file itself,
    // not just in the export UI copy.
    labResults: records.labResults,
    biomarkers: records.biomarkers,
    illnessEpisodes: records.illnessEpisodes,
    allergies: records.allergies,
    familyHistory: records.familyHistory,
    workouts: records.workouts,
    documents: records.documents,
    nutrientDays: nutrientDays.map((n) => ({
      day: n.day,
      nutrient: n.nutrient,
      amount: n.amount,
      unit: n.unit,
      source: n.source,
    })),
    manifest: records.manifest,
  };

  return {
    payload,
    counts: {
      measurements: measurements.length,
      medications: medications.length,
      intakeEvents: intakeEvents.length,
      moodEntries: moodEntries.length,
      cycles: cycle.cycles.length,
      cycleDayLogs: cycle.cycleDayLogs.length,
      nutrientDays: nutrientDays.length,
      ...countRecordsBackupSection(records),
    },
  };
}
