import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const queryRaw = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
    // loadUserSourcePriority lazy-loads the source-priority blob; null
    // (default findUnique) falls back to the default ladders.
    user: { findUnique: vi.fn() },
    // v1.28.25 — dense types (BLOOD_GLUCOSE / PULSE) day-bucket the
    // cold-tier fallback in SQL.
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

const readBestGranularityRollups = vi.fn();
const rollupRow = (bucketStart: Date, mean: number) => ({
  bucketStart,
  count: 30,
  mean,
  sd: null,
  slope: null,
  r2: null,
  sumValue: null,
  minValue: mean - 1,
  maxValue: mean + 1,
});
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: (...args: unknown[]) =>
    readBestGranularityRollups(...args),
  // aggregateWmyBuckets is no longer imported by graded-series, but keep the
  // module shape intact for any transitive consumer.
  aggregateWmyBuckets: vi.fn(),
}));

import { buildGradedSeriesWithRollups } from "../graded-series";

const dayMs = 24 * 60 * 60 * 1000;

/** Daily readings spanning `days` back from `now`. */
function dailyRows(days: number, now: Date) {
  const rows: Array<{ measuredAt: Date; value: number }> = [];
  for (let i = 0; i < days; i++) {
    rows.push({ measuredAt: new Date(now.getTime() - i * dayMs), value: 80 });
  }
  return rows;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildGradedSeriesWithRollups — rollup-miss fallback", () => {
  const now = new Date("2026-05-31T12:00:00Z");

  it("folds monthly/yearly from the bounded fallback when the tier has no coverage", async () => {
    // The bounded recent read (~90 d) returns only recent points; the
    // fallback read returns 2+ years so the fold has monthly/yearly.
    findMany
      // 1st call — bounded recent read (gte: since)
      .mockResolvedValueOnce(dailyRows(80, now))
      // 2nd call — bounded fallback read (gte: 1095-day horizon)
      .mockResolvedValueOnce(dailyRows(800, now));

    // Tier miss: no MONTH / YEAR coverage at all.
    readBestGranularityRollups.mockResolvedValue(null);

    const series = await buildGradedSeriesWithRollups("u1", "WEIGHT", now);

    // The bug: before the fix monthly/yearly were derived from the
    // bounded ~90-day read and so were always empty even when years of
    // raw history existed. After the fix they fold from the fallback.
    expect(series.monthly.length).toBeGreaterThan(0);
    // 800 days of history puts at least one year into the yearly tail.
    expect(series.yearly.length).toBeGreaterThan(0);
    // The fallback read must have been issued...
    expect(findMany).toHaveBeenCalledTimes(2);
    // ...and bounded (v1.28.25): it must carry a `measuredAt.gte` floor
    // ~1095 days back, never an unwindowed full-history walk.
    const fallbackArgs = findMany.mock.calls[1][0] as {
      where: { measuredAt?: { gte?: Date } };
    };
    const gte = fallbackArgs.where.measuredAt?.gte;
    expect(gte).toBeInstanceOf(Date);
    expect(gte!.getTime()).toBe(now.getTime() - 1095 * dayMs);
  });

  it("day-buckets the dense-type fallback in SQL instead of a raw walk (v1.28.25)", async () => {
    // BLOOD_GLUCOSE on a cold tier (heavy import before the rollup
    // backfill warms) used to findMany the entire CGM history. The
    // fallback now runs a single day-bucket aggregate; only the bounded
    // recent read touches findMany.
    findMany.mockResolvedValueOnce(dailyRows(80, now)); // bounded recent
    const bucketRows: Array<{ bucket_start: Date; mean: number }> = [];
    for (let i = 0; i < 800; i++) {
      bucketRows.push({
        bucket_start: new Date(now.getTime() - i * dayMs),
        mean: 100,
      });
    }
    queryRaw.mockResolvedValueOnce(bucketRows.reverse());

    readBestGranularityRollups.mockResolvedValue(null);

    const series = await buildGradedSeriesWithRollups(
      "u1",
      "BLOOD_GLUCOSE",
      now,
    );

    expect(series.monthly.length).toBeGreaterThan(0);
    expect(series.yearly.length).toBeGreaterThan(0);
    // Raw findMany ran once (the bounded recent read) — the fallback
    // itself went through the SQL aggregate.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reads monthly/yearly from the tier when it has coverage and skips the full read", async () => {
    findMany.mockResolvedValueOnce(dailyRows(80, now));

    // MONTH coverage for the 1-year window, YEAR coverage for the 3-year.
    readBestGranularityRollups.mockImplementation(
      async (_u: string, _t: string, windowDays: number) => {
        if (windowDays === 365) {
          return {
            granularity: "MONTH",
            rows: [
              rollupRow(new Date("2025-09-01T00:00:00Z"), 79),
              rollupRow(new Date("2025-10-01T00:00:00Z"), 80),
            ],
          };
        }
        return {
          granularity: "YEAR",
          rows: [rollupRow(new Date("2023-01-01T00:00:00Z"), 82)],
        };
      },
    );

    const series = await buildGradedSeriesWithRollups("u1", "WEIGHT", now);

    expect(series.monthly.length).toBeGreaterThan(0);
    expect(series.yearly.length).toBeGreaterThan(0);
    // Only the bounded recent read — no full-history fallback when the
    // tier covers both coarse slices.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("falls back to a full read for only the slice the tier misses", async () => {
    findMany
      .mockResolvedValueOnce(dailyRows(80, now)) // bounded recent
      .mockResolvedValueOnce(dailyRows(800, now)); // full-history fallback

    // MONTH covered, YEAR missing.
    readBestGranularityRollups.mockImplementation(
      async (_u: string, _t: string, windowDays: number) => {
        if (windowDays === 365) {
          return {
            granularity: "MONTH",
            rows: [rollupRow(new Date("2025-10-01T00:00:00Z"), 80)],
          };
        }
        return null;
      },
    );

    const series = await buildGradedSeriesWithRollups("u1", "WEIGHT", now);

    expect(series.monthly.length).toBeGreaterThan(0);
    expect(series.yearly.length).toBeGreaterThan(0);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
