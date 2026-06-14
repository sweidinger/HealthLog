/**
 * v1.16.16 — regression guard pinning rollup/live-SQL mean parity.
 *
 * The window mean recomposed from rollup buckets is the count-weighted
 * `Σ(count_i·mean_i) / Σcount_i` (DAY: `aggregateBuckets`; WMY:
 * `aggregateWmyBuckets`). Each bucket mean is itself a per-granularity
 * `AVG(raw)` minted by the writer via `GROUP BY date_trunc(...)` over
 * RAW rows — so the count-weighted recompose is algebraically the flat
 * `AVG(raw)` over the whole window, which is exactly what the live
 * fallback (`summaries-slice.ts:computeFromLiveAggregate` → `AVG(value)`)
 * returns.
 *
 * This test pins that equality for a seeded set spanning multiple
 * DAY / WEEK / MONTH buckets with UNEVEN per-day counts — the regime
 * where mean-of-rows and mean-of-daily-means genuinely diverge — so a
 * future change can't silently fold coarser buckets from daily means
 * (an equal-weight average) and reintroduce the divergence.
 */
import { describe, expect, it } from "vitest";

import { aggregateBuckets, type DailyMeanRow } from "../measurement-read";
import {
  aggregateWmyBuckets,
  type RollupBucketRow,
} from "../measurement-read-wmy";

/** One raw measurement: the day it falls on plus its value. */
interface RawRow {
  day: string; // YYYY-MM-DD, the date_trunc('day') key
  value: number;
}

/**
 * Deterministic seed spanning three calendar months with deliberately
 * UNEVEN per-day counts. The unevenness is load-bearing: it is the only
 * condition under which the count-weighted mean (mean-of-rows) and the
 * equal-weight mean-of-daily-means produce different numbers, so it is
 * the only seed that can catch a regression that swaps one for the other.
 */
const RAW: RawRow[] = [
  // 2026-03-02 — 1 reading
  { day: "2026-03-02", value: 90 },
  // 2026-03-03 — 5 readings (heavy day)
  { day: "2026-03-03", value: 80 },
  { day: "2026-03-03", value: 81 },
  { day: "2026-03-03", value: 82 },
  { day: "2026-03-03", value: 83 },
  { day: "2026-03-03", value: 84 },
  // 2026-03-17 — 2 readings (different WEEK + still March MONTH)
  { day: "2026-03-17", value: 78 },
  { day: "2026-03-17", value: 79 },
  // 2026-04-04 — 4 readings (April MONTH)
  { day: "2026-04-04", value: 70 },
  { day: "2026-04-04", value: 71 },
  { day: "2026-04-04", value: 72 },
  { day: "2026-04-04", value: 73 },
  // 2026-04-05 — 1 reading
  { day: "2026-04-05", value: 100 },
  // 2026-05-09 — 3 readings (May MONTH)
  { day: "2026-05-09", value: 60 },
  { day: "2026-05-09", value: 62 },
  { day: "2026-05-09", value: 64 },
];

/** Flat `AVG(value)` over every raw row — the live-fallback contract. */
function liveAvg(rows: RawRow[]): number {
  const sum = rows.reduce((acc, r) => acc + r.value, 0);
  return sum / rows.length;
}

/**
 * Mint per-day buckets exactly as the writer does: `GROUP BY
 * date_trunc('day', …)` then `count` + `AVG(value)` per group. This is
 * the DAY-rollup row the reader consumes.
 */
function dayBuckets(rows: RawRow[]): DailyMeanRow[] {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const list = byDay.get(r.day);
    if (list) list.push(r.value);
    else byDay.set(r.day, [r.value]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => ({
      day: new Date(`${day}T00:00:00.000Z`),
      count: values.length,
      mean: values.reduce((a, v) => a + v, 0) / values.length,
      minValue: Math.min(...values),
      maxValue: Math.max(...values),
    }));
}

/**
 * Mint per-month buckets the same way the WEEK/MONTH/YEAR writer does:
 * re-aggregate RAW (not fold DAY) under `GROUP BY date_trunc('month')`.
 */
function monthBuckets(rows: RawRow[]): RollupBucketRow[] {
  const byMonth = new Map<string, number[]>();
  for (const r of rows) {
    const month = r.day.slice(0, 7); // YYYY-MM
    const list = byMonth.get(month);
    if (list) list.push(r.value);
    else byMonth.set(month, [r.value]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({
      bucketStart: new Date(`${month}-01T00:00:00.000Z`),
      count: values.length,
      mean: values.reduce((a, v) => a + v, 0) / values.length,
      sd: 0,
      slope: 0,
      r2: 0,
      sumValue: null,
      minValue: Math.min(...values),
      maxValue: Math.max(...values),
    }));
}

/** Naive equal-weight mean of the per-day means — the WRONG number. */
function meanOfDailyMeans(buckets: { mean: number }[]): number {
  return buckets.reduce((a, b) => a + b.mean, 0) / buckets.length;
}

describe("rollup ↔ live AVG(raw) mean parity (uneven per-day counts)", () => {
  it("the seed actually exercises the divergent regime", () => {
    // Guard the guard: if a future edit flattens the counts so every day
    // carries the same number of readings, mean-of-rows would coincide
    // with mean-of-daily-means and this test would pass vacuously.
    const days = dayBuckets(RAW);
    const counts = new Set(days.map((d) => d.count));
    expect(counts.size).toBeGreaterThan(1);
  });

  it("DAY-bucket recompose equals live AVG(raw), not mean-of-daily-means", () => {
    const days = dayBuckets(RAW);
    const recomposed = aggregateBuckets(days);
    const live = liveAvg(RAW);
    const naive = meanOfDailyMeans(days);

    // The count-weighted recompose IS the flat AVG over raw rows.
    expect(recomposed.mean).toBeCloseTo(live, 10);
    // And it provably differs from the naive equal-weight average — the
    // exact bug class this guard exists to catch.
    expect(Math.abs(naive - live)).toBeGreaterThan(1e-6);
    expect(recomposed.mean).not.toBeCloseTo(naive, 4);
    // Total count is the raw row count, not the bucket count.
    expect(recomposed.count).toBe(RAW.length);
  });

  it("MONTH-bucket recompose equals live AVG(raw), not mean-of-monthly-means", () => {
    const months = monthBuckets(RAW);
    const recomposed = aggregateWmyBuckets(months);
    const live = liveAvg(RAW);
    const naive = meanOfDailyMeans(months);

    expect(recomposed.mean).toBeCloseTo(live, 10);
    expect(Math.abs(naive - live)).toBeGreaterThan(1e-6);
    expect(recomposed.mean).not.toBeCloseTo(naive, 4);
    expect(recomposed.count).toBe(RAW.length);
  });

  it("DAY and MONTH recompose agree (coarser tier re-aggregates raw, not folds DAY)", () => {
    const dayMean = aggregateBuckets(dayBuckets(RAW)).mean;
    const monthMean = aggregateWmyBuckets(monthBuckets(RAW)).mean;
    expect(dayMean).not.toBeNull();
    expect(monthMean).toBeCloseTo(dayMean ?? Number.NaN, 10);
  });
});
