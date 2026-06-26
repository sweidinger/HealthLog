/**
 * GET /api/insights/correlations — FDR-controlled correlation discovery.
 *
 * v1.10.0 — promotes the former placeholder to the real discovery engine.
 * Scans a curated behaviour × outcome matrix (daylight / mood / glucose /
 * BP / steps × sleep / HRV / resting HR / weight), lag-joins each behaviour
 * day to the NEXT day's outcome, runs Pearson with the exact Student-t
 * p-value, and applies Benjamini-Hochberg FDR control across every tested
 * pair so only statistically-defensible patterns surface. Every surfaced
 * pair carries n, r, p, and the BH-adjusted q, framed descriptive — never
 * causal.
 *
 * Reads daily series bounded to a trailing window, day-keyed in the user's
 * display timezone (late-night readings mis-bucket under UTC). Pure compute
 * lives in `src/lib/insights/correlation-discovery.ts`; this route only
 * fetches + day-keys + responds. No LLM, no narrative, no cache table.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  discoverCorrelations,
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  buildComplianceMedicationContext,
  buildMedicationComplianceBundle,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import {
  buildComplianceDailySeries,
  buildSymptomSeverityDailySeries,
  type SymptomDayLogRow,
  type SymptomEpisodeSpan,
} from "@/lib/insights/correlation-series-builders";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";

export const dynamic = "force-dynamic";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Trailing window for the discovery scan (days). */
const WINDOW_DAYS = 180;

/** Day key (YYYY-MM-DD) for an instant in the user's display timezone. */
function tzDayKey(at: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(at, tz);
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Collapse rows to per-day means keyed in the user's tz. */
function toDailyMeans(
  rows: Array<{ value: number; at: Date }>,
  tz: string,
): DailySeriesPoint[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.value)) continue;
    const day = tzDayKey(r.at, tz);
    const acc = byDay.get(day) ?? { sum: 0, count: 0 };
    acc.sum += r.value;
    acc.count += 1;
    byDay.set(day, acc);
  }
  return [...byDay.entries()]
    .map(([day, acc]) => ({ day, value: acc.sum / acc.count }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * v1.21.0 (FDREXTEND) — build the user's MEDICATION_COMPLIANCE daily series.
 *
 * Pools every active, non-PRN medication's unified dose-history ledger over the
 * window, then collapses to one per-day adherence rate (user-tz day keys). A
 * user with no active medications (or no resolved slots) yields an empty
 * series, so the channel degrades to absent.
 */
async function buildUserComplianceSeries(
  userId: string,
  since: Date,
  tz: string,
): Promise<NamedSeries> {
  const medications = await prisma.medication.findMany({
    // PRN (as-needed) medications have no expected doses → no defensible rate.
    where: { userId, active: true, asNeeded: false },
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
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
 * v1.21.0 (FDREXTEND) — build the user's SYMPTOM_SEVERITY daily series (role set
 * by the caller). Reads every in-window illness episode + its day-logs; the
 * builder zero-fills healthy days ONLY across real episode spans, so a user
 * with no episodes yields an empty series that degrades to absent.
 */
async function buildUserSymptomSeries(
  userId: string,
  since: Date,
  now: Date,
  tz: string,
): Promise<NamedSeries> {
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

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // v1.15.20 — shared analytics-read budget (generous; caps runaway loops).
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  // Operator can hide the correlation surface entirely.
  await requireAssistantSurface("correlations");

  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { timezone: true },
  });
  const tz = profile?.timezone ?? "Europe/Berlin";
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);

  // Non-MeasurementType channels are backed by other models, not measurements —
  // MOOD (MoodEntry), MEDICATION_COMPLIANCE (the dose-history ledger), and
  // SYMPTOM_SEVERITY (the illness day-log). `discoveryMeasurementTypes` drops
  // them so the `type IN (...)` query carries only real enum values; each is
  // built from its own source below and folded into the series.
  const behaviourTypes = discoveryMeasurementTypes(
    DISCOVERY_BEHAVIOURS,
  ) as MeasurementType[];
  const outcomeTypes = discoveryMeasurementTypes(
    DISCOVERY_OUTCOMES,
  ) as MeasurementType[];

  const [measurements, moodEntries] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        measuredAt: { gte: since },
        type: { in: [...behaviourTypes, ...outcomeTypes] },
      },
      orderBy: { measuredAt: "asc" },
      take: 20000,
      select: { type: true, value: true, measuredAt: true },
    }),
    prisma.moodEntry.findMany({
      where: { userId: user.id, deletedAt: null, moodLoggedAt: { gte: since } },
      orderBy: { moodLoggedAt: "asc" },
      take: 5000,
      select: { score: true, moodLoggedAt: true },
    }),
  ]);

  const measurementsByType = new Map<
    string,
    Array<{ value: number; at: Date }>
  >();
  for (const m of measurements) {
    const list = measurementsByType.get(m.type) ?? [];
    list.push({ value: m.value, at: m.measuredAt });
    measurementsByType.set(m.type, list);
  }

  // MOOD's daily-mean series is shared between its behaviour and outcome
  // roles (computed once).
  const moodDaily = toDailyMeans(
    moodEntries.map((e) => ({ value: e.score, at: e.moodLoggedAt })),
    tz,
  );

  // v1.21.0 (FDREXTEND) — build the two non-measurement, non-mood channels from
  // their own sources. Each degrades to an empty series when the user has no
  // data, so the discovery loop drops the channel (it cannot clear n ≥ 20).
  const complianceSeries = await buildUserComplianceSeries(user.id, since, tz);
  const symptomSeries = await buildUserSymptomSeries(user.id, since, now, tz);

  const points = (key: string): DailySeriesPoint[] =>
    key === "MOOD"
      ? moodDaily
      : toDailyMeans(measurementsByType.get(key) ?? [], tz);

  const series: NamedSeries[] = [];
  for (const key of DISCOVERY_BEHAVIOURS) {
    if (key === MEDICATION_COMPLIANCE_CHANNEL_KEY) {
      series.push(complianceSeries);
    } else if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
      series.push({ ...symptomSeries, role: "behaviour" });
    } else {
      series.push({ key, role: "behaviour", points: points(key) });
    }
  }
  for (const key of DISCOVERY_OUTCOMES) {
    if (key === SYMPTOM_SEVERITY_CHANNEL_KEY) {
      series.push({ ...symptomSeries, role: "outcome" });
    } else {
      series.push({ key, role: "outcome", points: points(key) });
    }
  }

  const result = discoverCorrelations(series);

  annotate({
    action: { name: "insights.correlations.discover" },
    meta: {
      pairs_tested: result.pairsTested,
      discovered: result.discovered.length,
      fdr_q: result.fdrQ,
      // FDREXTEND — per-channel day-counts so a dashboard can see whether the
      // two sparse new channels reached the n ≥ 20 floor or degraded to absent.
      compliance_days: complianceSeries.points.length,
      symptom_days: symptomSeries.points.length,
    },
  });

  return apiSuccess(result);
});
