/**
 * Structured-records / workouts / documents-manifest backup section.
 *
 * Shared by the on-demand full-backup builder (`full-backup-payload.ts`,
 * consumed by `GET /api/export/full-backup` + `POST /api/export/encrypted`)
 * AND the weekly `data-backup` pg-boss worker
 * (`src/lib/jobs/reminder/backup-handlers.ts`) so both writers emit the same
 * shape — the doc-comment convention `buildCycleBackupSection` already
 * established for the cycle tables.
 *
 * Closes the backup-completeness gap: the pre-existing payload covered
 * measurements / medications / intake events / mood / cycle only. This adds
 * lab results + the biomarker catalog, illness episodes (including
 * flares/exacerbations via `parentConditionId`) with their day-logs,
 * allergies, family history, and workout summaries.
 *
 * Every read is scoped to `userId` + `deletedAt: null` (soft-deleted rows
 * never resurrect into a backup). Encrypted free-text columns are decrypted
 * FAIL-SOFT (null on a bad key / corrupt row, with a wide-event warning) so
 * one damaged row never aborts an entire backup — the same posture the
 * illness/allergy/family-history DTO layer already uses for list-style
 * reads. Never the ciphertext itself leaves this module.
 *
 * Document BINARIES are deliberately excluded — see `DOCUMENTS_MANIFEST`.
 * Workout GPS routes + per-sample time series (`WorkoutRoute` /
 * `WorkoutSamples`) are deliberately excluded — see `WORKOUTS_MANIFEST`.
 * Both exclusions are disclosed in the payload's `manifest` section (and in
 * the export UI copy) rather than silently implied as "everything".
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { decryptNoteSoft } from "@/lib/labs/store";
import { decryptContextSoft } from "@/lib/labs/biomarker-store";
import { decryptDocumentSummary } from "@/lib/documents/store";
import { getEvent } from "@/lib/logging/context";
import {
  toIllnessEpisodeDTO,
  toIllnessDayLogDTO,
  dayLogSymptomInclude,
  type IllnessEpisodeDTO,
  type IllnessDayLogDTO,
} from "@/lib/illness/dto";
import {
  toAllergyDTO,
  toFamilyHistoryEntryDTO,
  type AllergyDTO,
  type FamilyHistoryEntryDTO,
} from "@/lib/records/dto";

/** Disclosed in the payload manifest AND mirrored in the export UI copy. */
export const DOCUMENTS_MANIFEST_NOTE =
  "Document metadata (title, filename, type, dates, and the AI-generated " +
  "summary if one was generated) is included. The original uploaded files " +
  "are NOT included in this export — download them individually from " +
  "Settings → Documents, or via the document API.";

/** Disclosed in the payload manifest AND mirrored in the export UI copy. */
export const WORKOUTS_MANIFEST_NOTE =
  "Workout summary records (duration, distance, heart rate, calories, " +
  "steps) are included. GPS routes and per-sample heart-rate/pace time " +
  "series are not included in this export.";

export interface LabResultBackupEntry {
  panel: string | null;
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  takenAt: string;
  source: string;
  /** Human-readable cross-reference into `biomarkers` below, not an id. */
  biomarkerName: string | null;
  note: string | null;
}

export interface BiomarkerBackupEntry {
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  hidden: boolean;
  context: string | null;
}

export interface WorkoutBackupEntry {
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  source: string;
  externalId: string | null;
}

export interface DocumentBackupEntry {
  id: string;
  kind: string;
  title: string | null;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  status: string;
  reportDate: string | null;
  documentDate: string | null;
  summary: string | null;
  createdAt: string;
}

export interface RecordsBackupSection {
  labResults: LabResultBackupEntry[];
  biomarkers: BiomarkerBackupEntry[];
  illnessEpisodes: Array<IllnessEpisodeDTO & { dayLogs: IllnessDayLogDTO[] }>;
  allergies: AllergyDTO[];
  familyHistory: FamilyHistoryEntryDTO[];
  workouts: WorkoutBackupEntry[];
  documents: DocumentBackupEntry[];
  manifest: {
    documents: { included: "metadata-only"; note: string };
    workouts: { included: "summary-only"; note: string };
  };
}

export interface RecordsBackupCounts {
  labResults: number;
  biomarkers: number;
  illnessEpisodes: number;
  illnessDayLogs: number;
  allergies: number;
  familyHistory: number;
  workouts: number;
  documents: number;
}

/** Decrypt a document's optional AI summary fail-soft (null on any error). */
function decryptSummarySoft(buf: Uint8Array | null): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptDocumentSummary(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `document summary decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Build the structured-records / workouts / documents-manifest slice of a
 * user's full backup. Accepts any client exposing the needed delegates (the
 * app's global `prisma` OR the pg-boss worker's `getWorkerPrisma()` client)
 * so both writers share one read.
 */
export async function buildRecordsBackupSection(
  prisma: Pick<
    PrismaClient,
    | "labResult"
    | "biomarker"
    | "illnessEpisode"
    | "allergy"
    | "familyHistoryEntry"
    | "workout"
    | "inboundDocument"
  >,
  userId: string,
): Promise<RecordsBackupSection> {
  const [
    labResultRows,
    biomarkerRows,
    episodeRows,
    allergyRows,
    familyRows,
    workoutRows,
    documentRows,
  ] = await Promise.all([
    prisma.labResult.findMany({
      where: { userId, deletedAt: null },
      orderBy: { takenAt: "desc" },
      include: { biomarker: { select: { name: true } } },
    }),
    prisma.biomarker.findMany({
      where: { userId },
      orderBy: { name: "asc" },
    }),
    prisma.illnessEpisode.findMany({
      where: { userId, deletedAt: null },
      orderBy: { onsetAt: "desc" },
      include: {
        dayLogs: {
          where: { deletedAt: null },
          orderBy: { date: "asc" },
          include: dayLogSymptomInclude,
        },
      },
    }),
    prisma.allergy.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.familyHistoryEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.workout.findMany({
      where: { userId },
      orderBy: { startedAt: "desc" },
    }),
    prisma.inboundDocument.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        title: true,
        filename: true,
        mimeType: true,
        byteSize: true,
        status: true,
        reportDate: true,
        documentDate: true,
        summaryEncrypted: true,
        createdAt: true,
      },
    }),
  ]);

  const labResults: LabResultBackupEntry[] = labResultRows.map((r) => ({
    panel: r.panel,
    analyte: r.analyte,
    value: r.value,
    valueText: r.valueText,
    unit: r.unit,
    referenceLow: r.referenceLow,
    referenceHigh: r.referenceHigh,
    takenAt: r.takenAt.toISOString(),
    source: r.source,
    biomarkerName: r.biomarker?.name ?? null,
    note: decryptNoteSoft(r.noteEncrypted),
  }));

  const biomarkers: BiomarkerBackupEntry[] = biomarkerRows.map((b) => ({
    name: b.name,
    unit: b.unit,
    lowerBound: b.lowerBound,
    upperBound: b.upperBound,
    panel: b.panel,
    hidden: b.hidden,
    context: decryptContextSoft(b.contextEncrypted),
  }));

  const illnessEpisodes = episodeRows.map((row) => ({
    ...toIllnessEpisodeDTO(row),
    dayLogs: row.dayLogs.map(toIllnessDayLogDTO),
  }));

  const allergies = allergyRows.map(toAllergyDTO);
  const familyHistory = familyRows.map(toFamilyHistoryEntryDTO);

  const workouts: WorkoutBackupEntry[] = workoutRows.map((w) => ({
    sportType: w.sportType,
    startedAt: w.startedAt.toISOString(),
    endedAt: w.endedAt.toISOString(),
    durationSec: w.durationSec,
    totalEnergyKcal: w.totalEnergyKcal,
    totalDistanceM: w.totalDistanceM,
    avgHeartRate: w.avgHeartRate,
    maxHeartRate: w.maxHeartRate,
    minHeartRate: w.minHeartRate,
    stepCount: w.stepCount,
    elevationM: w.elevationM,
    pauseDurationSec: w.pauseDurationSec,
    source: w.source,
    externalId: w.externalId,
  }));

  const documents: DocumentBackupEntry[] = documentRows.map((d) => ({
    id: d.id,
    kind: d.kind,
    title: d.title,
    filename: d.filename,
    mimeType: d.mimeType,
    byteSize: d.byteSize,
    status: d.status,
    reportDate: d.reportDate ? d.reportDate.toISOString().slice(0, 10) : null,
    documentDate: d.documentDate
      ? d.documentDate.toISOString().slice(0, 10)
      : null,
    summary: decryptSummarySoft(d.summaryEncrypted),
    createdAt: d.createdAt.toISOString(),
  }));

  return {
    labResults,
    biomarkers,
    illnessEpisodes,
    allergies,
    familyHistory,
    workouts,
    documents,
    manifest: {
      documents: { included: "metadata-only", note: DOCUMENTS_MANIFEST_NOTE },
      workouts: { included: "summary-only", note: WORKOUTS_MANIFEST_NOTE },
    },
  };
}

/** Row counts for the audit trail / annotate() meta, mirroring `FullBackupCounts`. */
export function countRecordsBackupSection(
  section: RecordsBackupSection,
): RecordsBackupCounts {
  return {
    labResults: section.labResults.length,
    biomarkers: section.biomarkers.length,
    illnessEpisodes: section.illnessEpisodes.length,
    illnessDayLogs: section.illnessEpisodes.reduce(
      (sum, e) => sum + e.dayLogs.length,
      0,
    ),
    allergies: section.allergies.length,
    familyHistory: section.familyHistory.length,
    workouts: section.workouts.length,
    documents: section.documents.length,
  };
}
