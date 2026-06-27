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
  discoverEmergingCorrelations,
  discoverLabOutcomeCorrelations,
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  EARLY_WINDOW_DAYS,
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import {
  fetchComplianceSeries,
  fetchLabDraws,
  fetchSymptomSeries,
} from "@/lib/insights/correlation-channel-series";

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
  // v1.22 — lab draws (for the labs ↔ outcome pass) fetch alongside.
  const [complianceSeries, symptomSeries, labDraws] = await Promise.all([
    fetchComplianceSeries(user.id, tz, since),
    fetchSymptomSeries(user.id, tz, since),
    fetchLabDraws(user.id, tz, since),
  ]);

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

  // v1.22 — rolling early-detection pass over the trailing window, re-using
  // the already-built series (no extra DB read). Emerging pairs exclude anything
  // the retrospective scan already established (no double-count).
  const recentFromDayKey = tzDayKey(
    new Date(now.getTime() - EARLY_WINDOW_DAYS * MS_PER_DAY),
    tz,
  );
  const emerging = discoverEmergingCorrelations(series, result, {
    recentFromDayKey,
  });

  // v1.22 — labs ↔ outcome pass (point-vs-window over sparse draws). Degrades
  // to absent when the user has too few draws to clear the per-pair floor.
  const labCorrelations = discoverLabOutcomeCorrelations(labDraws, series);

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
      // v1.22 — early-detection + labs reach.
      emerging: emerging.emerging.length,
      emerging_window_days: emerging.windowDays,
      lab_draws: labDraws.length,
      lab_correlations: labCorrelations.discovered.length,
    },
  });

  return apiSuccess({ ...result, emerging, labCorrelations });
});
