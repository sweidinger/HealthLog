/**
 * v1.9.0 — period-over-period range deltas for a single metric.
 *
 * Background
 * ----------
 * The Insights metric pages render fixed windows (`avg7`, `avg30`,
 * `slope7/30/90`). A user-selectable time-range with a "vs prior period"
 * delta needs two reads of the same metric: the current window and the
 * previous comparable window, composed into a delta. This is exactly the
 * two-window pattern `computeAvg30LastYearForType` already uses for the
 * year-ago baseline (`summaries-slice.ts`) — current = the trailing window,
 * previous = the equally-sized window immediately before it.
 *
 * Single metric, two reads, no fan-out
 * ------------------------------------
 * The route this backs is single-metric (the metric page is single-metric),
 * so the cost is one `readBestGranularityRollups` call covering the trailing
 * `2N` days, sliced into the current and previous halves. No per-type fan-out,
 * no Prisma-pool burst — the opposite of the deleted 15-way live walk.
 *
 * Compositional contract
 * ----------------------
 * `count / min / max / mean / sum` are linearly composable across buckets
 * (the rollup tier's compositional contract — `measurement-read-wmy.ts`), so
 * a window aggregate built from WEEK / MONTH buckets equals the per-row
 * aggregate over the same span. SD / slope / r² are intentionally NOT part of
 * the delta — they do not compose, matching the rest of the WMY reader tier.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import {
  aggregateWmyBuckets,
  readBestGranularityRollups,
  type RollupBucketRow,
} from "@/lib/rollups/measurement-read-wmy";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The user-selectable ranges. */
export const ANALYTICS_RANGES = ["7d", "30d", "90d", "1y"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** Trailing-window length, in days, for each range. */
const RANGE_WINDOW_DAYS: Record<AnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export function rangeWindowDays(range: AnalyticsRange): number {
  return RANGE_WINDOW_DAYS[range];
}

/** A composed window aggregate. `mean`/etc. are null when the window is empty. */
export interface WindowAggregate {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
}

export interface RangeDeltaResult {
  range: AnalyticsRange;
  windowDays: number;
  /** The granularity the underlying rollup read resolved against. */
  granularity: string;
  current: WindowAggregate;
  previous: WindowAggregate;
  /**
   * `current.mean - previous.mean`, or null when either window has no mean
   * (no data in the current or prior window) — never a misleading 0.
   */
  delta: number | null;
  /**
   * `delta / previous.mean` as a fraction (0.03 = +3 %), or null when the
   * prior window has no mean / a zero mean (no divide-by-zero, no misleading
   * 0 %). The client renders "no prior-period data" in that case.
   */
  deltaPct: number | null;
}

/**
 * Slice the resolved buckets into the current half (`[now-N, now)`) and the
 * previous half (`[now-2N, now-N)`) and compose each. Pure over the bucket
 * rows + the window boundaries so the composition is unit-testable without a
 * DB. `bucketStart` is the slice key — the same conservative overlap filter
 * `computeAvg30LastYearForType` uses (a bucket counts toward the half its
 * `bucketStart` falls into).
 */
export function sliceWindowDelta(
  rows: RollupBucketRow[],
  windowDays: number,
  now: number,
): { current: WindowAggregate; previous: WindowAggregate } {
  const currentStart = now - windowDays * DAY_MS;
  const previousStart = now - 2 * windowDays * DAY_MS;
  const currentRows: RollupBucketRow[] = [];
  const previousRows: RollupBucketRow[] = [];
  for (const row of rows) {
    const t = row.bucketStart.getTime();
    if (t >= currentStart && t < now) {
      currentRows.push(row);
    } else if (t >= previousStart && t < currentStart) {
      previousRows.push(row);
    }
  }
  return {
    current: aggregateWmyBuckets(currentRows),
    previous: aggregateWmyBuckets(previousRows),
  };
}

/**
 * Compose the period-over-period delta from the two window aggregates.
 * Pure — pinned by unit test. Guards both the missing-data case (either
 * window empty → delta null) and the divide-by-zero case (prior mean zero or
 * null → deltaPct null) so the caption never paints a misleading 0 %.
 */
export function composeDelta(
  current: WindowAggregate,
  previous: WindowAggregate,
): { delta: number | null; deltaPct: number | null } {
  if (current.mean === null || previous.mean === null) {
    return { delta: null, deltaPct: null };
  }
  const delta = current.mean - previous.mean;
  const deltaPct = previous.mean !== 0 ? delta / previous.mean : null;
  return { delta, deltaPct };
}

/**
 * Read the current vs previous window for one `(userId, type)` and compose
 * the delta. Reads a single `2N`-day window through the granularity router so
 * both halves resolve at the same granularity (the comparison stays
 * apples-to-apples). Returns a zeroed result on a coverage miss — the route
 * still answers 200 with empty windows so the UI shows "no prior-period
 * data" rather than erroring.
 */
export async function computeRangeDelta(
  userId: string,
  type: MeasurementType,
  range: AnalyticsRange,
  now: number = Date.now(),
): Promise<RangeDeltaResult> {
  const windowDays = rangeWindowDays(range);
  // Read the full 2N span in one go so the current and previous halves share
  // a granularity; the router picks the coarsest tier that resolves 2N.
  const resolved = await readBestGranularityRollups(userId, type, windowDays * 2);
  if (!resolved) {
    const empty: WindowAggregate = {
      count: 0,
      min: null,
      max: null,
      mean: null,
      sum: null,
    };
    return {
      range,
      windowDays,
      granularity: "none",
      current: empty,
      previous: empty,
      delta: null,
      deltaPct: null,
    };
  }
  const { current, previous } = sliceWindowDelta(resolved.rows, windowDays, now);
  const { delta, deltaPct } = composeDelta(current, previous);
  return {
    range,
    windowDays,
    granularity: resolved.granularity,
    current,
    previous,
    delta,
    deltaPct,
  };
}
