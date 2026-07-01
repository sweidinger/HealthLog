/**
 * v1.19.2 W-CHARTS — `readDailySeries` long-range tier step-up.
 *
 * Pins that a window WIDER than the DAY bucket cap routes through the
 * tiered rollup reader (whole-history coverage, downsampled by tier)
 * instead of the DAY path that would `LIMIT`/`slice` to the cap and
 * silently drop the older history. Short / normal windows must NOT touch
 * the tiered reader, so the common case stays byte-identical with the
 * pre-v1.19.2 daily path (no perf regression).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  readTieredRollupSeries: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurementRollup: { findMany: mocks.findMany },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readTieredRollupSeries: mocks.readTieredRollupSeries,
}));

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeUserRollups: vi.fn(),
}));

import { readDailySeries } from "../daily-series-read";

const DAY_MS = 86_400_000;

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.queryRaw.mockReset();
  mocks.readTieredRollupSeries.mockReset();
  // Default DAY-rollup read returns enough rows (≥ SUSPICIOUS_ROW_FLOOR)
  // so the short-window path resolves without the coverage probe / live
  // query firing.
  mocks.findMany.mockResolvedValue([
    {
      type: "WEIGHT",
      source: "MANUAL",
      bucketStart: new Date("2026-06-01T00:00:00.000Z"),
      mean: 81,
      count: 1,
      sumValue: null,
      minValue: 81,
      maxValue: 81,
    },
    {
      type: "WEIGHT",
      source: "MANUAL",
      bucketStart: new Date("2026-06-02T00:00:00.000Z"),
      mean: 82,
      count: 1,
      sumValue: null,
      minValue: 82,
      maxValue: 82,
    },
    {
      type: "WEIGHT",
      source: "MANUAL",
      bucketStart: new Date("2026-06-03T00:00:00.000Z"),
      mean: 80,
      count: 1,
      sumValue: null,
      minValue: 80,
      maxValue: 80,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readDailySeries — long-range tier step-up", () => {
  it("routes a multi-year window through the tiered reader and returns its whole-history rows", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 3650 * DAY_MS);
    const tieredRows = [
      {
        type: "WEIGHT",
        value: 80,
        measuredAt: "2017-01-01T00:00:00.000Z",
        count: 12,
      },
      {
        type: "WEIGHT",
        value: 79,
        measuredAt: "2026-01-01T00:00:00.000Z",
        count: 12,
      },
    ];
    mocks.readTieredRollupSeries.mockResolvedValueOnce({
      granularity: "MONTH",
      rows: tieredRows,
    });

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
    });

    expect(mocks.readTieredRollupSeries).toHaveBeenCalledTimes(1);
    // v1.26.0 SEAM-N2 — the resolved `[from, to]` bounds are threaded so the
    // tier reads the REQUESTED window, not a trailing "to now" slice.
    expect(mocks.readTieredRollupSeries.mock.calls[0][0].from).toBe(from);
    expect(mocks.readTieredRollupSeries.mock.calls[0][0].to).toBe(to);
    // Whole-history coverage: the earliest 2017 bucket survives.
    expect(result[0].measuredAt).toBe("2017-01-01T00:00:00.000Z");
    expect(result).toHaveLength(2);
    // The DAY-rollup path was NOT consulted for the long window.
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("falls through to the daily path on a tiered coverage miss (no silent empty)", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 3650 * DAY_MS);
    mocks.readTieredRollupSeries.mockResolvedValueOnce(null);

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
    });

    expect(mocks.readTieredRollupSeries).toHaveBeenCalledTimes(1);
    // Daily DAY-rollup read still ran as the fallback.
    expect(mocks.findMany).toHaveBeenCalled();
    expect(result).toHaveLength(3);
  });

  it("does NOT touch the tiered reader for a normal 90-day window", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 90 * DAY_MS);

    await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
    });

    expect(mocks.readTieredRollupSeries).not.toHaveBeenCalled();
    expect(mocks.findMany).toHaveBeenCalled();
  });
});
