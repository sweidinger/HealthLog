/**
 * v1.21.0 (INTEGFIX) — shared data-fetching helpers for the two non-measurement
 * FDR correlation channels (medication compliance + symptom severity).
 *
 * The pure series shapers live in `correlation-series-builders.ts`; the FDR
 * engine itself is pure over `NamedSeries[]`. These two helpers own the DB reads
 * that feed those shapers — the dose-history ledger (compliance) and the illness
 * day-log (symptom severity) — so EVERY consumer of the discovery matrix (the
 * `/api/insights/correlations` route AND the Coach `get_correlations` tool)
 * builds the channels identically rather than re-implementing the queries, the
 * tz keying, and the episode-span clamping per call site.
 *
 * Each helper degrades to an EMPTY series when the user has no data, so the
 * channel drops out of discovery (it cannot clear the n ≥ 20 floor) rather than
 * fabricating a constant.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import {
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type LabDrawPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import { resolveLabFields } from "@/lib/labs/serialise";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { ENVIRONMENT_FIELDS } from "@/lib/environment/fields";
import {
  buildComplianceDailySeries,
  buildSymptomSeverityDailySeries,
  type SymptomDayLogRow,
  type SymptomEpisodeSpan,
} from "@/lib/insights/correlation-series-builders";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";

/**
 * v1.21.0 (FDREXTEND) — build the user's MEDICATION_COMPLIANCE daily series.
 *
 * Pools every active, non-PRN medication's unified dose-history ledger over the
 * window, then collapses to one per-day adherence rate (user-tz day keys). A
 * user with no active medications (or no resolved slots) yields an empty
 * series, so the channel degrades to absent.
 */
export async function fetchComplianceSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries> {
  const medications = await prisma.medication.findMany({
    // PRN (as-needed) medications have no expected doses → no defensible rate.
    where: { userId, active: true, asNeeded: false },
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
    orderBy: { name: "asc" },
  });
  if (medications.length === 0) {
    return {
      key: MEDICATION_COMPLIANCE_CHANNEL_KEY,
      role: "behaviour",
      points: [],
    };
  }

  const events = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      medicationId: { in: medications.map((med) => med.id) },
      scheduledFor: { gte: since },
    },
    orderBy: { scheduledFor: "asc" },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  const now = new Date();
  const ledgerRows: DoseHistoryRow[] = [];
  for (const medication of medications) {
    const medEvents = events.filter((e) => e.medicationId === medication.id);
    const ctx = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(medEvents),
      tz,
    );
    const bundle = buildMedicationComplianceBundle(
      medEvents,
      medication.schedules,
      ctx,
      now,
    );
    ledgerRows.push(...bundle.ledgerRows);
  }

  return buildComplianceDailySeries(ledgerRows, tz);
}

/**
 * v1.21.0 (FDREXTEND) — build the user's SYMPTOM_SEVERITY daily series in the
 * `outcome` role (callers that need the behaviour role re-tag the returned
 * series — the points are role-invariant). Reads every in-window illness episode
 * + its day-logs; the builder zero-fills healthy days ONLY across real episode
 * spans, so a user with no episodes yields an empty series that degrades to
 * absent.
 */
export async function fetchSymptomSeries(
  userId: string,
  tz: string,
  since: Date,
): Promise<NamedSeries> {
  const now = new Date();
  const episodes = await prisma.illnessEpisode.findMany({
    // An episode overlaps the window when it onset before `now` and either is
    // ongoing or resolved at/after the window start.
    where: {
      userId,
      deletedAt: null,
      onsetAt: { lte: now },
      OR: [{ resolvedAt: null }, { resolvedAt: { gte: since } }],
    },
    select: { id: true, onsetAt: true, resolvedAt: true },
  });
  if (episodes.length === 0) {
    return { key: SYMPTOM_SEVERITY_CHANNEL_KEY, role: "outcome", points: [] };
  }

  const dayLogRows = await prisma.illnessDayLog.findMany({
    where: {
      userId,
      deletedAt: null,
      episodeId: { in: episodes.map((e) => e.id) },
    },
    select: {
      date: true,
      functionalImpact: true,
      symptomLinks: { select: { severity: true } },
    },
  });

  // Collapse each day-log to one burden value (functionalImpact, else the day's
  // max linked symptom severity) — the same rule the recovery-gap track uses.
  const dayLogs: SymptomDayLogRow[] = [];
  for (const row of dayLogRows) {
    if (row.functionalImpact != null) {
      dayLogs.push({ day: row.date, impact: row.functionalImpact });
      continue;
    }
    let maxSeverity: number | null = null;
    for (const link of row.symptomLinks) {
      if (link.severity == null) continue;
      maxSeverity =
        maxSeverity === null
          ? link.severity
          : Math.max(maxSeverity, link.severity);
    }
    if (maxSeverity != null)
      dayLogs.push({ day: row.date, impact: maxSeverity });
  }

  const spans: SymptomEpisodeSpan[] = episodes.map((e) => ({
    onsetAt: e.onsetAt,
    resolvedAt: e.resolvedAt,
  }));

  return buildSymptomSeverityDailySeries({
    dayLogs,
    episodes: spans,
    tz,
    windowStart: since,
    windowEnd: now,
    role: "outcome",
  });
}

/**
 * v1.25 (W-ENV) — build the user's environmental-exposure BEHAVIOUR channels.
 *
 * One {@link NamedSeries} per registered env field (temperature, daylight,
 * sunshine, precipitation, pressure mean + intraday swing), read from the daily
 * `EnvironmentContext` rows the nightly job stores. Each row's `date` is already
 * a YYYY-MM-DD key, so points need no re-keying. Sunshine / daylight are stored
 * in seconds and surfaced as hours (correlation r is scale-invariant; hours just
 * keep the series readable). A field with no non-null values yields an empty
 * series that degrades to absent — never a fabricated constant. The whole set is
 * empty when the user has no environment rows (module off / no home set).
 */
export async function fetchEnvironmentSeries(
  userId: string,
  since: Date,
): Promise<NamedSeries[]> {
  const sinceKey = since.toISOString().slice(0, 10);
  const rows = await prisma.environmentContext.findMany({
    where: { userId, date: { gte: sinceKey } },
    orderBy: { date: "asc" },
    take: 1000,
    select: {
      date: true,
      tempMean: true,
      tempMin: true,
      tempMax: true,
      apparentMean: true,
      sunshineSec: true,
      daylightSec: true,
      precipSum: true,
      pressureMean: true,
      pressureDelta: true,
      humidityMean: true,
      cloudMean: true,
    },
  });

  return ENVIRONMENT_FIELDS.map((field) => {
    const points: DailySeriesPoint[] = [];
    for (const row of rows) {
      const raw = row[field.column];
      if (raw == null || !Number.isFinite(raw)) continue;
      // Seconds → hours for the duration fields; pass through otherwise.
      const value =
        field.column === "sunshineSec" || field.column === "daylightSec"
          ? raw / 3600
          : raw;
      points.push({ day: row.date, value });
    }
    return { key: field.key, role: "behaviour" as const, points };
  });
}

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * v1.22 — build the user's lab draws for the labs ↔ outcome correlation pass.
 *
 * One {@link LabDrawPoint} per QUANTITATIVE reading in the window, keyed
 * `LAB:<canonical analyte>` (the resolved name, so two spellings of one marker
 * collapse). HIDDEN biomarkers are excluded (the W3 catalog `hidden` flag — a
 * marker the user retired from the active list must not silently re-enter an
 * analysis surface). Qualitative readings (no numeric `value`) and rows whose
 * resolved value is non-finite are dropped — there is nothing to correlate.
 * The encrypted note column is never selected.
 *
 * Returns an EMPTY array when the user has no usable readings, so the discovery
 * pass degrades to absent rather than fabricating a link.
 */
export async function fetchLabDraws(
  userId: string,
  tz: string,
  since: Date,
): Promise<LabDrawPoint[]> {
  const now = new Date();
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      value: { not: null },
      takenAt: { gte: since, lte: now },
    },
    orderBy: { takenAt: "asc" },
    take: 5000,
    select: {
      analyte: true,
      unit: true,
      referenceLow: true,
      referenceHigh: true,
      panel: true,
      value: true,
      takenAt: true,
      biomarkerId: true,
      biomarker: {
        select: {
          id: true,
          name: true,
          unit: true,
          lowerBound: true,
          upperBound: true,
          panel: true,
          hidden: true,
        },
      },
    },
  });

  const draws: LabDrawPoint[] = [];
  for (const row of rows) {
    // Exclude retired markers (W3 hidden flag); unlinked rows cannot be hidden.
    if (row.biomarker?.hidden) continue;
    if (row.value === null || !Number.isFinite(row.value)) continue;
    const resolved = resolveLabFields(row, row.biomarker);
    draws.push({
      key: `LAB:${resolved.analyte}`,
      day: tzDayKey(row.takenAt, tz),
      value: row.value,
    });
  }
  return draws;
}
