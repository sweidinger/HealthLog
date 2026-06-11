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
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import type { MeasurementType } from "@/generated/prisma/client";
import {
  discoverCorrelations,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
  type DailySeriesPoint,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";

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

  // Operator can hide the correlation surface entirely.
  await requireAssistantSurface("correlations");

  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { timezone: true },
  });
  const tz = profile?.timezone ?? "Europe/Berlin";
  const since = new Date(Date.now() - WINDOW_DAYS * MS_PER_DAY);

  // MOOD is backed by mood entries, not measurements — it appears as both a
  // behaviour and (v1.11.5 F3) an outcome channel, so filter it out of the
  // measurement type list on either side.
  const behaviourTypes = DISCOVERY_BEHAVIOURS.filter(
    (k) => k !== "MOOD",
  ) as MeasurementType[];
  const outcomeTypes = DISCOVERY_OUTCOMES.filter(
    (k) => k !== "MOOD",
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

  const measurementsByType = new Map<string, Array<{ value: number; at: Date }>>();
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

  const series: NamedSeries[] = [];
  for (const key of DISCOVERY_BEHAVIOURS) {
    const points =
      key === "MOOD" ? moodDaily : toDailyMeans(measurementsByType.get(key) ?? [], tz);
    series.push({ key, role: "behaviour", points });
  }
  for (const key of DISCOVERY_OUTCOMES) {
    const points =
      key === "MOOD" ? moodDaily : toDailyMeans(measurementsByType.get(key) ?? [], tz);
    series.push({ key, role: "outcome", points });
  }

  const result = discoverCorrelations(series);

  annotate({
    action: { name: "insights.correlations.discover" },
    meta: {
      pairs_tested: result.pairsTested,
      discovered: result.discovered.length,
      fdr_q: result.fdrQ,
    },
  });

  return apiSuccess(result);
});
