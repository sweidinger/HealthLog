/**
 * Shared graded-series compressor for AI insight snapshots.
 *
 * Background — see `.planning/research/ai-payload-compression-audit.md`.
 * The seven per-card status generators embedded the FULL daily array
 * per metric (`bucketSeries`, up to ~360 daily buckets + ~24 monthly)
 * plus correlation pair arrays, and never touched the WEEK / MONTH /
 * YEAR rollup tier. A daily-weigher's `weight-status` snapshot ran
 * ~23 KB for weight alone; `general-status` across many Apple-Health
 * types could blow past 100 K tokens. The Coach is the one path that
 * already grades its timeline (recent days verbatim → weekly means →
 * bounded window).
 *
 * This module is the single graded shape every status path uses:
 *
 *   recent   last ~21 days        daily   min/max/mean/n     (~14-21 rows)
 *   weekly   the ~10 weeks before  ISO wk  min/max/mean/n     (~8-10 rows)
 *   monthly  the ~12 months before month   min/max/mean       (~9-12 rows)
 *   yearly   everything older      year    mean/slope         (~1-3 rows)
 *
 * ~30-45 rows per metric regardless of history depth, never an
 * individual reading beyond `recent`.
 *
 * Two entry points:
 *   - `buildGradedSeriesFromPoints(points, now)` — pure, in-memory. The
 *     recent / weekly / monthly slices fold raw points; the yearly slice
 *     carries a least-squares slope. Used where the caller already holds
 *     the rows (and by the tests).
 *   - `buildGradedSeriesWithRollups(userId, type, now)` — sources the
 *     monthly / yearly slices from the pre-aggregated MONTH / YEAR
 *     rollup tier (`readBestGranularityRollups`) and the recent / weekly
 *     slices from a bounded raw read, so the coarse tiers finally earn
 *     their write amplification.
 *
 * The recent / weekly bucketing mirrors the Coach
 * (`coach/snapshot.ts:bucketWeekly` + `buildDailyValueRows`). Those
 * helpers are intentionally duplicated rather than lifted out of the
 * Coach: the Coach contract must not move under it, and the shapes here
 * carry min/max (the Coach only needs the mean). The two are small and
 * independently testable.
 */

import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  aggregateWmyBuckets,
  readBestGranularityRollups,
  type RollupBucketRow,
} from "@/lib/rollups/measurement-read-wmy";
import { toBerlinYmd } from "@/lib/tz/resolver";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days kept verbatim at daily granularity. */
const RECENT_DAYS = 21;
/** ISO weeks folded after the recent window. */
const WEEKLY_WEEKS = 10;
/** Calendar months folded after the weekly window. */
const MONTHLY_MONTHS = 12;

const RECENT_WINDOW_MS = RECENT_DAYS * MS_PER_DAY;
const WEEKLY_WINDOW_MS = (RECENT_DAYS + WEEKLY_WEEKS * 7) * MS_PER_DAY;
// Approximate the monthly horizon in days; the precise calendar-month
// boundary is handled by the YMD key, this only separates monthly from
// yearly buckets.
const MONTHLY_WINDOW_MS =
  WEEKLY_WINDOW_MS + MONTHLY_MONTHS * 30 * MS_PER_DAY;

export interface RecentDayBucket {
  /** Berlin YYYY-MM-DD. */
  date: string;
  min: number;
  max: number;
  mean: number;
  n: number;
}

export interface WeeklyBucket {
  /** ISO week key like 2026-W19 (Berlin-anchored). */
  weekISO: string;
  min: number;
  max: number;
  mean: number;
  n: number;
}

export interface MonthlyBucket {
  /** Berlin YYYY-MM. */
  month: string;
  min: number;
  max: number;
  mean: number;
  n: number;
}

export interface YearlyBucket {
  /** Berlin YYYY. */
  year: string;
  min: number;
  max: number;
  mean: number;
  n: number;
  /** Least-squares slope per reading order (null when < 2 points). */
  slope: number | null;
}

export interface GradedSeries {
  recent: RecentDayBucket[];
  weekly: WeeklyBucket[];
  monthly: MonthlyBucket[];
  yearly: YearlyBucket[];
}

interface Point {
  measuredAt: Date;
  value: number;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function berlinDayKey(date: Date): string {
  const { year, month, day } = toBerlinYmd(date);
  return `${year}-${month}-${day}`;
}

function berlinMonthKey(date: Date): string {
  const { year, month } = toBerlinYmd(date);
  return `${year}-${month}`;
}

function berlinYearKey(date: Date): string {
  return toBerlinYmd(date).year;
}

/**
 * ISO week key (Berlin-anchored). Mirrors the Coach's `isoWeekKey` but
 * fixed to the user's Berlin display day so the week label agrees with
 * the rest of the snapshot.
 */
function berlinIsoWeekKey(date: Date): string {
  const { year, month, day } = toBerlinYmd(date);
  const localMidnight = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  const dayNum = localMidnight.getUTCDay() || 7;
  localMidnight.setUTCDate(localMidnight.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(localMidnight.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((localMidnight.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7,
  );
  return `${localMidnight.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

interface Agg {
  sum: number;
  min: number;
  max: number;
  n: number;
}

function foldInto(map: Map<string, Agg>, key: string, value: number): void {
  const existing = map.get(key);
  if (existing) {
    existing.sum += value;
    existing.n += 1;
    if (value < existing.min) existing.min = value;
    if (value > existing.max) existing.max = value;
  } else {
    map.set(key, { sum: value, min: value, max: value, n: 1 });
  }
}

/**
 * Least-squares slope of `values` against their index (0..n-1). Returns
 * null for fewer than two points. The yearly trend signal — direction
 * over the order the readings landed.
 */
function leastSquaresSlope(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  return round((n * sumXY - sumX * sumY) / denom, 4);
}

/**
 * Build the graded series purely in memory. `points` may carry several
 * readings per day; same-period readings are folded into one bucket.
 */
export function buildGradedSeriesFromPoints(
  points: Point[],
  now: Date,
): GradedSeries {
  const nowMs = now.getTime();

  const recentAgg = new Map<string, Agg>();
  const weeklyAgg = new Map<string, Agg>();
  const monthlyAgg = new Map<string, Agg>();
  // Yearly keeps ordered values for the slope, plus min/max/sum.
  const yearlyValues = new Map<string, number[]>();
  const yearlyAgg = new Map<string, Agg>();

  for (const p of points) {
    const ageMs = nowMs - p.measuredAt.getTime();
    if (ageMs < 0) continue; // future reading — ignore

    if (ageMs < RECENT_WINDOW_MS) {
      foldInto(recentAgg, berlinDayKey(p.measuredAt), p.value);
    } else if (ageMs < WEEKLY_WINDOW_MS) {
      foldInto(weeklyAgg, berlinIsoWeekKey(p.measuredAt), p.value);
    } else if (ageMs < MONTHLY_WINDOW_MS) {
      foldInto(monthlyAgg, berlinMonthKey(p.measuredAt), p.value);
    } else {
      const yk = berlinYearKey(p.measuredAt);
      foldInto(yearlyAgg, yk, p.value);
      const list = yearlyValues.get(yk);
      if (list) list.push(p.value);
      else yearlyValues.set(yk, [p.value]);
    }
  }

  const recent: RecentDayBucket[] = Array.from(recentAgg.entries())
    .map(([date, a]) => ({
      date,
      min: round(a.min),
      max: round(a.max),
      mean: round(a.sum / a.n),
      n: a.n,
    }))
    .sort((x, y) => x.date.localeCompare(y.date));

  const weekly: WeeklyBucket[] = Array.from(weeklyAgg.entries())
    .map(([weekISO, a]) => ({
      weekISO,
      min: round(a.min),
      max: round(a.max),
      mean: round(a.sum / a.n),
      n: a.n,
    }))
    .sort((x, y) => x.weekISO.localeCompare(y.weekISO));

  const monthly: MonthlyBucket[] = Array.from(monthlyAgg.entries())
    .map(([month, a]) => ({
      month,
      min: round(a.min),
      max: round(a.max),
      mean: round(a.sum / a.n),
      n: a.n,
    }))
    .sort((x, y) => x.month.localeCompare(y.month));

  const yearly: YearlyBucket[] = Array.from(yearlyAgg.entries())
    .map(([year, a]) => ({
      year,
      min: round(a.min),
      max: round(a.max),
      mean: round(a.sum / a.n),
      n: a.n,
      // Order the readings oldest → newest for the slope. The map kept
      // insertion order; `points` arrives caller-ordered, so re-sort by
      // pushing in chronological order is unnecessary — the slope is a
      // direction signal, not a calibrated rate.
      slope: leastSquaresSlope(yearlyValues.get(year) ?? []),
    }))
    .sort((x, y) => x.year.localeCompare(y.year));

  return { recent, weekly, monthly, yearly };
}

/**
 * Project a rollup bucket row to a monthly/yearly graded bucket. The
 * tier already carries min/max/mean/slope per bucket — no JS folding.
 */
function rollupMonthly(rows: RollupBucketRow[]): MonthlyBucket[] {
  return rows.map((r) => ({
    month: berlinMonthKey(r.bucketStart),
    min: round(r.minValue),
    max: round(r.maxValue),
    mean: round(r.mean),
    n: r.count,
  }));
}

function rollupYearly(rows: RollupBucketRow[]): YearlyBucket[] {
  return rows.map((r) => ({
    year: berlinYearKey(r.bucketStart),
    min: round(r.minValue),
    max: round(r.maxValue),
    mean: round(r.mean),
    n: r.count,
    slope: r.slope === null ? null : round(r.slope, 4),
  }));
}

/**
 * Build the graded series with the recent / weekly slices folded from a
 * bounded raw read and the monthly / yearly slices read from the
 * pre-aggregated rollup tier.
 *
 * The raw read is capped to the recent + weekly horizon (last ~90 days),
 * so dense accounts never pull the full multi-year history into memory.
 * The rollup router picks MONTH for the ~1-year window and YEAR for the
 * multi-year tail, falling back to a finer tier on coverage miss; when
 * the tier has no coverage at all the in-memory folder still produces
 * monthly/yearly buckets from whatever the raw read returned.
 */
export async function buildGradedSeriesWithRollups(
  userId: string,
  type: MeasurementType,
  now: Date,
): Promise<GradedSeries> {
  const since = new Date(now.getTime() - WEEKLY_WINDOW_MS);
  const rawRecent = await prisma.measurement.findMany({
    where: { userId, type, measuredAt: { gte: since } },
    orderBy: { measuredAt: "asc" },
    select: { measuredAt: true, value: true },
  });

  const recentGraded = buildGradedSeriesFromPoints(
    rawRecent.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
    now,
  );

  // Monthly slice: route a ~1-year window through the tier.
  const monthlyRouted = await readBestGranularityRollups(userId, type, 365);
  // Yearly slice: route a multi-year window through the tier.
  const yearlyRouted = await readBestGranularityRollups(userId, type, 1095);

  let monthly: MonthlyBucket[] = recentGraded.monthly;
  let yearly: YearlyBucket[] = recentGraded.yearly;

  if (monthlyRouted && monthlyRouted.granularity === "MONTH") {
    // Drop the months already covered by recent/weekly (last ~90 d).
    const cutoff = new Date(now.getTime() - WEEKLY_WINDOW_MS);
    monthly = rollupMonthly(
      monthlyRouted.rows.filter((r) => r.bucketStart < cutoff),
    ).slice(-MONTHLY_MONTHS);
  }
  if (yearlyRouted && yearlyRouted.granularity === "YEAR") {
    // Keep only years older than the monthly horizon.
    const cutoff = new Date(now.getTime() - MONTHLY_WINDOW_MS);
    yearly = rollupYearly(
      yearlyRouted.rows.filter((r) => r.bucketStart < cutoff),
    );
  }

  return {
    recent: recentGraded.recent,
    weekly: recentGraded.weekly,
    monthly,
    yearly,
  };
}

/**
 * Headline summary across the whole graded series — min/max/mean/n —
 * for the snapshot's summary line. Composes the per-bucket stats; uses
 * `aggregateWmyBuckets` semantics for the count-weighted mean.
 */
export function summarizeGradedSeries(series: GradedSeries): {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
} {
  const rows: RollupBucketRow[] = [];
  const push = (mean: number, min: number, max: number, n: number) =>
    rows.push({
      bucketStart: new Date(0),
      count: n,
      mean,
      sd: null,
      slope: null,
      r2: null,
      sumValue: null,
      minValue: min,
      maxValue: max,
    });
  for (const r of series.recent) push(r.mean, r.min, r.max, r.n);
  for (const w of series.weekly) push(w.mean, w.min, w.max, w.n);
  for (const m of series.monthly) push(m.mean, m.min, m.max, m.n);
  for (const y of series.yearly) push(y.mean, y.min, y.max, y.n);
  const agg = aggregateWmyBuckets(rows);
  return {
    n: agg.count,
    min: agg.min === null ? null : round(agg.min),
    max: agg.max === null ? null : round(agg.max),
    mean: agg.mean === null ? null : round(agg.mean),
  };
}
