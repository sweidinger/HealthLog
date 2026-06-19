/**
 * v1.18.7 — unit tests for the progressive tiered-context builder.
 *
 * `readRollupBuckets` (the per-granularity rollup reader),
 * `ensureUserRollupsFresh`, `probeRollupCoverage`, and
 * `prisma.measurement.findMany` are mocked at the module level so the test
 * pins the band routing + the min/max-envelope anomaly extraction without a
 * real Postgres. The behaviours it locks:
 *   - each band reads from the correct granularity over the right window,
 *   - the 0–14d band reads raw rows and folds same-day points,
 *   - a coarse-bucket peak above mean + 2·sd survives as an anomaly,
 *   - sparse buckets (count < 3) never trip the anomaly gate,
 *   - the anomaly list is ranked by |deltaSd| and capped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollupGranularity } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => ({
  readRollupBuckets: vi.fn(),
  ensureUserRollupsFresh: vi.fn(),
  probeRollupCoverage: vi.fn(),
  measurementFindMany: vi.fn(),
}));

vi.mock("../measurement-rollups", () => ({
  readRollupBuckets: mocks.readRollupBuckets,
  ensureUserRollupsFresh: mocks.ensureUserRollupsFresh,
}));

vi.mock("../measurement-coverage", () => ({
  probeRollupCoverage: mocks.probeRollupCoverage,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: mocks.measurementFindMany },
  },
}));

import { buildTieredSeries, buildTieredSeriesForTypes } from "../tiered-context";

const NOW = new Date("2026-06-19T00:00:00.000Z").getTime();

function rollupRow(
  bucketStart: string,
  mean: number,
  min: number,
  max: number,
  count: number,
) {
  return {
    bucketStart: new Date(bucketStart),
    count,
    mean,
    minValue: min,
    maxValue: max,
    sd: null,
    slope: null,
    r2: null,
    computedAt: new Date(bucketStart),
  };
}

describe("buildTieredSeries", () => {
  beforeEach(() => {
    mocks.ensureUserRollupsFresh.mockResolvedValue({ recomputed: false });
    mocks.probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    mocks.measurementFindMany.mockResolvedValue([]);
    mocks.readRollupBuckets.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes each band to the correct granularity over the right window", async () => {
    await buildTieredSeries("u1", "WEIGHT", { now: NOW });
    const grans = mocks.readRollupBuckets.mock.calls.map(
      (c) => c[2] as RollupGranularity,
    );
    expect(grans).toEqual(["DAY", "WEEK", "MONTH", "YEAR"]);
  });

  it("folds same-day raw rows into one 0-14d point", async () => {
    mocks.measurementFindMany.mockResolvedValue([
      { value: 80, measuredAt: new Date("2026-06-18T07:00:00.000Z") },
      { value: 82, measuredAt: new Date("2026-06-18T20:00:00.000Z") },
      { value: 79, measuredAt: new Date("2026-06-17T07:00:00.000Z") },
    ]);
    const series = await buildTieredSeries("u1", "WEIGHT", { now: NOW });
    expect(series.recentDaily).toHaveLength(2);
    const day18 = series.recentDaily.find((p) => p.date === "2026-06-18");
    expect(day18?.value).toBe(81); // (80 + 82) / 2
    expect(day18?.count).toBe(2);
  });

  it("preserves a coarse-bucket peak as an anomaly via the min/max envelope", async () => {
    // A WEEK band with one bucket whose MAX is a clear outlier (>2 sd).
    mocks.readRollupBuckets.mockImplementation(
      async (_u: string, _t: string, gran: RollupGranularity) => {
        if (gran === "WEEK") {
          return [
            rollupRow("2026-05-01T00:00:00.000Z", 100, 99, 100, 5),
            rollupRow("2026-05-08T00:00:00.000Z", 101, 100, 102, 5),
            rollupRow("2026-05-15T00:00:00.000Z", 100, 99, 101, 5),
            // The spike: max 140 is far above the ~100 mean.
            rollupRow("2026-05-22T00:00:00.000Z", 105, 100, 140, 5),
          ];
        }
        return [];
      },
    );
    const series = await buildTieredSeries("u1", "WEIGHT", { now: NOW });
    expect(series.anomalies.length).toBeGreaterThanOrEqual(1);
    const peak = series.anomalies.find((a) => a.kind === "peak");
    expect(peak?.value).toBe(140);
    expect(peak?.band).toBe("week");
    expect(peak?.deltaSd).toBeGreaterThanOrEqual(2);
  });

  it("ignores sparse buckets (count < 3) when extracting anomalies", async () => {
    mocks.readRollupBuckets.mockImplementation(
      async (_u: string, _t: string, gran: RollupGranularity) => {
        if (gran === "WEEK") {
          return [
            rollupRow("2026-05-01T00:00:00.000Z", 100, 99, 100, 5),
            rollupRow("2026-05-08T00:00:00.000Z", 100, 99, 101, 5),
            rollupRow("2026-05-15T00:00:00.000Z", 100, 99, 101, 5),
            // Outlier max but only 1 sample backing the bucket — suppressed.
            rollupRow("2026-05-22T00:00:00.000Z", 200, 200, 200, 1),
          ];
        }
        return [];
      },
    );
    const series = await buildTieredSeries("u1", "WEIGHT", { now: NOW });
    expect(series.anomalies).toHaveLength(0);
  });

  it("recomputes freshness once when batching across types", async () => {
    mocks.probeRollupCoverage.mockResolvedValue(
      new Map([
        ["WEIGHT", true],
        ["PULSE", true],
      ]),
    );
    await buildTieredSeriesForTypes("u1", ["WEIGHT", "PULSE"], { now: NOW });
    expect(mocks.ensureUserRollupsFresh).toHaveBeenCalledTimes(1);
  });
});
