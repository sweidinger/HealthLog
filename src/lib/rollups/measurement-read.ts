/**
 * v1.5.0 — read-side helpers that aggregate the persistent rollup
 * table into the same `DataSummary` shape the live aggregator
 * returns. The reader-side surfaces (`summaries-slice`,
 * `comprehensive-aggregator`, the analytics route) re-aggregate the
 * trailing DAY buckets directly via `readRollupBuckets` and feed the
 * resulting rows into `aggregateBuckets` below.
 *
 * The 90-day window is reconstructed from DAY buckets by:
 *   - sum(count_i)              → window count
 *   - min(min_i)                → window min
 *   - max(max_i)                → window max
 *   - sum(count_i × mean_i) / Σcount_i → window mean (weighted by daily count)
 *
 * That re-aggregation is mathematically exact for `count`, `min`,
 * `max`, and `mean` — they are linearly composable across DAY buckets.
 * SD / slope / R² are NOT exact: aggregating across DAY buckets is not
 * the same as the population stats over the raw rows. For those, the
 * rollup-read path delegates to live SQL so the byte-shape parity with
 * the v1.4.34.1 / 4.5 aggregator survives.
 */

import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";

/**
 * v1.11.1 — load a user's source-priority blob for the rollup collapse.
 * `null` makes `collapseRollupRowsBySource` fall back to the default ladders.
 * Callers that read many types in a loop should load it once and thread it
 * through, rather than paying one lookup per read.
 */
export async function loadUserSourcePriority(userId: string): Promise<unknown> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { sourcePriorityJson: true },
  });
  return user?.sourcePriorityJson ?? null;
}

export interface DailyMeanRow {
  day: Date;
  count: number;
  mean: number;
  minValue: number;
  maxValue: number;
}

/**
 * v1.20.0 F6 — per-bucket OLS regression accumulators (epoch-day x-axis).
 * Mirrors the four columns migration 0190 added to `measurement_rollups`
 * plus the `n` / `Σy` the existing `count` / `mean` already carry. A bucket
 * whose accumulators predate the migration (or whose write missed the
 * re-fold) reports `sumXy === null`; the reader treats any null in the
 * window as a coverage miss and falls back to the live REGR_* path.
 */
export interface RegressionAccumulators {
  count: number;
  /** Σy = mean·count (the writer stores mean + count; Σy is derived). */
  mean: number;
  sumX: number | null;
  sumXy: number | null;
  sumXx: number | null;
  sumYy: number | null;
}

/** Closed-form windowed regression result. `null` when undefined. */
export interface ComposedRegression {
  slope: number | null;
  r2: number | null;
  /** Population standard deviation (divides by n, matching STDDEV_POP). */
  sdPop: number | null;
}

/**
 * v1.20.0 F6 — compose a windowed OLS slope / r² / population-sd from the
 * summed regression accumulators of a set of DAY buckets.
 *
 * The six terms (`n = Σcount`, `Σx`, `Σy = Σ(mean·count)`, `Σxy`, `Σxx`,
 * `Σyy`) are ADDITIVE across buckets, so summing the per-bucket
 * accumulators over the window and evaluating the closed form yields a
 * result BIT-IDENTICAL to Postgres `REGR_SLOPE` / `REGR_R2` / `STDDEV_POP`
 * over the same raw rows (Postgres folds the same accumulators):
 *
 *   slope  = (n·Σxy − Σx·Σy) / (n·Σxx − Σx²)
 *   r²     = (n·Σxy − Σx·Σy)² / ((n·Σxx − Σx²)(n·Σyy − Σy²))
 *   sd_pop = sqrt(Σyy/n − (Σy/n)²)
 *
 * The caller MUST collapse overlapping sources to the canonical source
 * BEFORE handing rows here — the accumulators are per-source, so summing a
 * dual-source day's two rows would double-count the reading. Pass the
 * already-source-collapsed bucket set.
 *
 * Coverage contract: returns `{ null, null, null }` (a full miss) when
 *   - any bucket in the window has a `null` accumulator (pre-migration row
 *     the boot re-fold has not refilled), or
 *   - the window holds fewer than 2 readings, or
 *   - a denominator degenerates to 0 (no x-variance / no y-variance).
 *
 * The caller treats a miss as "fall back to live SQL", so a partially
 * back-filled window never silently returns a wrong (partial) regression.
 *
 * Postgres' REGR_SLOPE / REGR_R2 ignore rows with a NULL dependent or
 * independent value; `value` and `measured_at` are NOT NULL on
 * `measurements`, so every raw row contributes and the accumulator `n`
 * equals the live `regr_count`.
 */
export function composeRegression(
  buckets: ReadonlyArray<RegressionAccumulators>,
): ComposedRegression {
  const MISS: ComposedRegression = { slope: null, r2: null, sdPop: null };
  if (buckets.length === 0) return MISS;

  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXy = 0;
  let sumXx = 0;
  let sumYy = 0;
  for (const b of buckets) {
    // Any null accumulator in the window means the row predates the
    // accumulator columns (or its re-fold is pending) — bail to live SQL
    // rather than compose a regression over an incomplete window.
    if (
      b.sumX === null ||
      b.sumXy === null ||
      b.sumXx === null ||
      b.sumYy === null
    ) {
      return MISS;
    }
    n += b.count;
    sumX += b.sumX;
    // Σy is reconstructed from the stored mean·count, matching the live
    // SUM(value) over the same rows.
    sumY += b.mean * b.count;
    sumXy += b.sumXy;
    sumXx += b.sumXx;
    sumYy += b.sumYy;
  }

  if (n < 2) return MISS;

  const denomX = n * sumXx - sumX * sumX;
  const denomY = n * sumYy - sumY * sumY;
  const cov = n * sumXy - sumX * sumY;

  const slope = denomX === 0 ? null : cov / denomX;
  // REGR_R2 is null when either variance is zero (matches Postgres).
  const r2 =
    denomX === 0 || denomY === 0 ? null : (cov * cov) / (denomX * denomY);

  // Population variance: Σyy/n − (Σy/n)². Clamp tiny negative values that
  // float rounding can produce when the variance is effectively zero.
  const variance = sumYy / n - (sumY / n) * (sumY / n);
  const sdPop = variance <= 0 ? 0 : Math.sqrt(variance);

  return { slope, r2, sdPop };
}

/** Minimal shape the source collapse needs from a per-source rollup row. */
export interface SourcedBucketRow {
  bucketStart: Date;
  source: MeasurementSource;
  count: number;
}

/**
 * v1.11.1 — collapse per-source rollup rows to ONE row per bucket using the
 * user's source-priority ladder. The writer mints one row per
 * (type, day, source); this resolves overlapping sources (e.g. WHOOP + Apple
 * Watch resting heart rate) to the ladder-canonical reading before the linear
 * composition in `aggregateBuckets` / the WMY readers runs. Cumulative types
 * collapse to the single canonical source too, so the caller reads that one
 * source's summed `sumValue` — a day's total reflects one source, never a
 * cross-source sum.
 *
 * Resolution per bucket:
 *   1. the first source in the metric's ladder that is present → canonical;
 *   2. no ladder match (an unlisted source, or a type with no ladder) → the
 *      row with the alphabetically smallest source name, so the bucket
 *      neither doubles nor goes dark AND the pick matches the live-SQL
 *      paths' `ORDER BY … source` tiebreak.
 *
 * Input order is preserved (buckets emit in first-seen order). A single-source
 * day (the common case) short-circuits to the row unchanged.
 */
export function collapseRollupRowsBySource<T extends SourcedBucketRow>(
  rows: T[],
  type: MeasurementType,
  userPriorityJson: unknown,
): T[] {
  if (rows.length <= 1) return rows;

  const byBucket = new Map<number, T[]>();
  for (const row of rows) {
    const key = row.bucketStart.getTime();
    const slot = byBucket.get(key);
    if (slot) slot.push(row);
    else byBucket.set(key, [row]);
  }

  const metricKey = metricKeyForType(type);
  const ladder: readonly MeasurementSource[] = metricKey
    ? getSourceLadder(parseSourcePriority(userPriorityJson), metricKey)
    : [];

  const out: T[] = [];
  for (const bucketRows of byBucket.values()) {
    if (bucketRows.length === 1) {
      out.push(bucketRows[0]);
      continue;
    }
    let picked: T | undefined;
    for (const source of ladder) {
      const hit = bucketRows.find((r) => r.source === source);
      if (hit) {
        picked = hit;
        break;
      }
    }
    if (!picked) {
      // No ladder match — keep one row deterministically by alphabetically
      // smallest source name, so the bucket neither doubles nor goes dark AND
      // the pick matches the live-SQL paths' `ORDER BY … source` tiebreak
      // (live/rollup parity for a ranked type whose day carries only
      // non-ladder sources).
      picked = bucketRows.reduce((best, r) =>
        r.source < best.source ? r : best,
      );
    }
    out.push(picked);
  }
  return out;
}

/**
 * v1.20.0 F6 — a DAY bucket carrying its `bucketStart` plus the
 * regression accumulators. The windowed-regression readers consume an
 * array of these (one canonical-source row per day) and slice them into
 * the 7/30/90-day sub-windows before composing.
 */
export interface AccumulatorBucketRow extends RegressionAccumulators {
  bucketStart: Date;
}

/**
 * v1.20.0 F6 — compose a windowed slope / r² / population-sd over the DAY
 * buckets whose `bucketStart` falls on or after `since`.
 *
 * The window is DAY-aligned (a bucket is in-window iff its `bucketStart`
 * is `>= since`), matching the DAY-rollup grain. Callers anchor `since` on
 * a UTC-day boundary (`startOfUtcDay(now − N days)`) so the window is the
 * day-aligned equivalent of the live `measured_at >= NOW() - INTERVAL 'N
 * days'` filter. The accumulator-composed result over a given bucket set
 * is bit-identical to live REGR_* / STDDEV_POP over the same buckets' raw
 * rows — the parity test pins this.
 *
 * Returns a full miss `{ null, null, null }` when any in-window bucket
 * lacks accumulators (see `composeRegression`), so a partially back-filled
 * window falls through to live SQL rather than returning a partial answer.
 */
export function composeWindowedRegression(
  rows: ReadonlyArray<AccumulatorBucketRow>,
  since: Date,
): ComposedRegression {
  const cutoff = since.getTime();
  const inWindow = rows.filter((r) => r.bucketStart.getTime() >= cutoff);
  return composeRegression(inWindow);
}

/**
 * v1.20.0 P3 M-1 — true iff any in-window DAY bucket carries a NULL
 * regression accumulator (a row that predates migration 0190, or whose
 * boot re-fold has not yet refilled it). `composeWindowedRegression`
 * collapses both that case AND the legitimate "< 2 readings" / degenerate
 * cases into the same `{ null, null, null }` miss, so the reader cannot
 * tell from the composed result alone whether a null slope is the honest
 * answer or a coverage gap pending backfill.
 *
 * The slim / comprehensive readers call this alongside the compose so they
 * can annotate the miss (`regression_source:"unavailable_pending_backfill"`)
 * per the project's "no silent cap / log any truncation" rule. The null
 * value itself stays — it converges once the boot backfill refills the
 * accumulators — but the MISS becomes observable rather than silent.
 *
 * Window contract matches `composeWindowedRegression`: a bucket is
 * in-window iff its `bucketStart` is `>= since`.
 */
export function hasPendingAccumulatorBackfill(
  rows: ReadonlyArray<AccumulatorBucketRow>,
  since: Date,
): boolean {
  const cutoff = since.getTime();
  for (const r of rows) {
    if (r.bucketStart.getTime() < cutoff) continue;
    if (
      r.sumX === null ||
      r.sumXy === null ||
      r.sumXx === null ||
      r.sumYy === null
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Combine DAY buckets into the linearly-composable window stats —
 * `count`, `min`, `max`, `mean`. SD / slope / R² are intentionally
 * NOT computed here because they don't compose across DAY rollups.
 */
export function aggregateBuckets(rows: DailyMeanRow[]): {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
} {
  if (rows.length === 0) {
    return { count: 0, min: null, max: null, mean: null };
  }
  let totalCount = 0;
  let sumWeighted = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    totalCount += r.count;
    sumWeighted += r.count * r.mean;
    if (r.minValue < min) min = r.minValue;
    if (r.maxValue > max) max = r.maxValue;
  }
  if (totalCount === 0) {
    return { count: 0, min: null, max: null, mean: null };
  }
  return {
    count: totalCount,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    mean: sumWeighted / totalCount,
  };
}
