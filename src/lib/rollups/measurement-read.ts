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
