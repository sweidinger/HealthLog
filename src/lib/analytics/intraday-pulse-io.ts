/**
 * S11 — IO seam for the intraday pulse / tension layer.
 *
 * Loads ONE local day's raw signals on demand (read-swap; never persisted as
 * 10-min rollups) and hands them to the pure `intraday-pulse` computations:
 *
 *   - raw PULSE for the day → the 10-minute mean shape;
 *   - the personal resting baseline (RESTING_HEART_RATE, else the
 *     low-percentile PULSE proxy) → the elevation line;
 *   - intraday step samples → the mandatory low-movement gate;
 *   - workouts overlapping the day → exercise never reads as tension;
 *   - intraday HRV (WHOOP RMSSD) below the personal median → an optional
 *     confirming flag.
 *
 * Shared by `GET /api/insights/pulse/intraday` (the chart) and the daily
 * digest's `tension_window` builder, so the signal is computed one way.
 */
import { prisma } from "@/lib/db";
import { percentile } from "@/lib/insights/strain-score";
import { resolveRestingPulseSeries } from "@/lib/analytics/resting-pulse";
import {
  BUCKET_MINUTES,
  HOURLY_BUCKET_MINUTES,
  MIN_BASELINE_DAYS,
  computeHourlyMeanSeries,
  computeTenMinuteMeanSeries,
  detectTensionWindow,
  makeLocalResolver,
  type IntradayHrBucket,
  type IntradayResolution,
  type LocalResolver,
  type TensionWindow,
  type WorkoutInterval,
} from "@/lib/analytics/intraday-pulse";

/** UTC padding around the local calendar day so the query is a safe superset. */
const WINDOW_LEAD_MS = 15 * 60 * 60 * 1000; // covers UTC−14…+12 day starts
const WINDOW_TRAIL_MS = 39 * 60 * 60 * 1000;

/** Defensive read caps — dense Apple-Health accounts emit ~1 sample/second. */
const MAX_DAY_PULSE_ROWS = 6000;
const MAX_DAY_STEP_ROWS = 2000;

/** The DTO both the route and the digest read. */
export interface IntradayPulseResult {
  dateKey: string;
  timezone: string;
  bucketMinutes: number;
  series: IntradayHrBucket[];
  baseline: number | null;
  baselineSource: "resting" | "proxy" | "none";
  tension: TensionWindow | null;
  /**
   * S11 day navigator — `"tenMin"` when `series` was folded from live raw
   * per-sample rows, `"hourly"` when the day fell outside
   * `DENSE_INTRADAY_RETENTION_DAYS` and `series` is the coarser fallback
   * read off the folded `stats:` hourly-mean tier instead. `tension` is
   * always `null` on an `"hourly"` day — see `detectTensionWindow`'s
   * docblock for why a tension read needs per-sample resolution.
   */
  resolution: IntradayResolution;
}

/** Median (p50), or null on an empty series. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(percentile(values, 50) * 10) / 10;
}

/**
 * Resolve the personal resting baseline and its maturity. Prefers the clean
 * RESTING_HEART_RATE rows; falls back to the low-percentile PULSE proxy. The
 * baseline is the median of the resolved daily series — robust to the odd
 * outlier — and is "mature" only once at least `MIN_BASELINE_DAYS` distinct
 * daily points exist.
 */
async function resolveBaseline(userId: string): Promise<{
  baseline: number | null;
  mature: boolean;
  source: "resting" | "proxy" | "none";
}> {
  const restingRows = await prisma.measurement.findMany({
    where: { userId, type: "RESTING_HEART_RATE", deletedAt: null },
    orderBy: { measuredAt: "desc" },
    take: 90,
    select: { value: true, measuredAt: true },
  });

  // Only reach for the heavier PULSE-history read when resting rows are thin.
  const pulseHistory =
    restingRows.length >= MIN_BASELINE_DAYS
      ? []
      : await prisma.measurement.findMany({
          where: { userId, type: "PULSE", deletedAt: null },
          orderBy: { measuredAt: "desc" },
          take: 365,
          select: { value: true, measuredAt: true },
        });

  const resolved = resolveRestingPulseSeries({
    restingSamples: restingRows.map((r) => ({
      measuredAt: r.measuredAt,
      value: r.value,
    })),
    pulseSamples: pulseHistory.map((r) => ({
      measuredAt: r.measuredAt,
      value: r.value,
    })),
  });

  const recent = resolved.series.slice(-30).map((p) => p.value);
  return {
    baseline: median(recent),
    mature: resolved.series.length >= MIN_BASELINE_DAYS,
    source: resolved.which,
  };
}

/** Clamp a workout's local span to [0, 1440) minutes on `dateKey`, or null. */
function workoutToInterval(
  startedAt: Date,
  endedAt: Date,
  dateKey: string,
  localOf: LocalResolver,
): WorkoutInterval | null {
  const s = localOf(startedAt);
  const e = localOf(endedAt);
  // Reject spans entirely outside the day (both ends on another calendar day
  // on the same side); otherwise clamp an overhanging end into the day.
  const startMinute =
    s.dayKey === dateKey ? s.minuteOfDay : s.dayKey < dateKey ? 0 : -1;
  const endMinute =
    e.dayKey === dateKey ? e.minuteOfDay : e.dayKey > dateKey ? 24 * 60 : -1;
  if (startMinute < 0 || endMinute < 0 || endMinute <= startMinute) return null;
  return { startMinute, endMinute };
}

/**
 * Compute the intraday pulse shape + (cautious) tension window for one local
 * day. Deterministic given the DB state; performs no AI/provider call.
 */
export async function loadIntradayPulse(
  userId: string,
  timezone: string,
  dateKey: string,
): Promise<IntradayPulseResult> {
  const localOf = makeLocalResolver(timezone);
  const anchorMs = new Date(`${dateKey}T00:00:00.000Z`).getTime();
  const start = new Date(anchorMs - WINDOW_LEAD_MS);
  const end = new Date(anchorMs + WINDOW_TRAIL_MS);

  const [pulseRows, stepRows, workoutRows, baseline] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: "PULSE",
        deletedAt: null,
        measuredAt: { gte: start, lte: end },
      },
      orderBy: { measuredAt: "asc" },
      take: MAX_DAY_PULSE_ROWS,
      select: { value: true, measuredAt: true, externalId: true },
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "ACTIVITY_STEPS",
        deletedAt: null,
        measuredAt: { gte: start, lte: end },
      },
      orderBy: { measuredAt: "asc" },
      take: MAX_DAY_STEP_ROWS,
      select: { value: true, measuredAt: true, externalId: true },
    }),
    prisma.workout.findMany({
      where: {
        userId,
        startedAt: { lt: end },
        endedAt: { gt: start },
      },
      select: { startedAt: true, endedAt: true },
    }),
    resolveBaseline(userId),
  ]);

  // Split live PULSE rows into raw per-sample rows and already-folded
  // `stats:` hourly-mean rows (the dense-intraday-retention fold's output —
  // see `dense-intraday-retention.ts`). A day's raw rows are folded and
  // tombstoned atomically as a whole, so in practice a day is either wholly
  // raw or wholly folded; the split still guards against ever mixing the two
  // grains into one mislabeled series.
  const rawPulseRows = pulseRows.filter(
    (r) => !r.externalId?.startsWith("stats:"),
  );
  const foldedPulseRows = pulseRows.filter((r) =>
    r.externalId?.startsWith("stats:"),
  );

  const tenMinSeries = computeTenMinuteMeanSeries(
    rawPulseRows.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
    dateKey,
    localOf,
  );

  // Day-navigator fallback (S11 / v1.29.x): a day outside
  // `DENSE_INTRADAY_RETENTION_DAYS` has its raw rows tombstoned by the
  // retention fold, so `tenMinSeries` comes back empty even though the day's
  // shape survives at hour resolution in the folded `stats:` tier. Fall back
  // to that coarser read rather than rendering an empty chart. A day with
  // genuinely no data at all (never synced) stays on the empty "tenMin"
  // series — `foldedPulseRows` is empty there too, so `hourlySeries` is
  // empty and the branch below is skipped.
  const useHourlyFallback = tenMinSeries.length === 0;
  const hourlySeries = useHourlyFallback
    ? computeHourlyMeanSeries(
        foldedPulseRows.map((r) => ({
          measuredAt: r.measuredAt,
          value: r.value,
        })),
        dateKey,
        localOf,
      )
    : [];

  const resolution: IntradayResolution =
    useHourlyFallback && hourlySeries.length > 0 ? "hourly" : "tenMin";
  const series = resolution === "hourly" ? hourlySeries : tenMinSeries;

  // Intraday step buckets — EXCLUDE the consolidated `stats:` daily totals, or a
  // single day-sum row would dump the whole day's steps into one bucket and
  // wrongly mark an at-rest stretch as moving.
  const stepBuckets = new Map<number, number>();
  for (const row of stepRows) {
    if (row.externalId?.startsWith("stats:")) continue;
    const local = localOf(row.measuredAt);
    if (local.dayKey !== dateKey) continue;
    const startMinute =
      Math.floor(local.minuteOfDay / BUCKET_MINUTES) * BUCKET_MINUTES;
    stepBuckets.set(
      startMinute,
      (stepBuckets.get(startMinute) ?? 0) + row.value,
    );
  }

  const workouts = workoutRows
    .map((w) => workoutToInterval(w.startedAt, w.endedAt, dateKey, localOf))
    .filter((w): w is WorkoutInterval => w !== null);

  // Tension needs per-sample resolution (see `detectTensionWindow`'s
  // docblock) — never compute it against the hourly fallback, regardless of
  // what the (independently folded) step tier happens to report.
  const tension =
    resolution === "tenMin"
      ? detectTensionWindow({
          buckets: series,
          baseline: baseline.baseline,
          baselineMature: baseline.mature,
          stepBuckets,
          workouts,
          hrvConfirmMinutes: [],
        })
      : null;

  return {
    dateKey,
    timezone,
    bucketMinutes:
      resolution === "hourly" ? HOURLY_BUCKET_MINUTES : BUCKET_MINUTES,
    series,
    baseline: baseline.baseline,
    baselineSource: baseline.source,
    tension,
    resolution,
  };
}
