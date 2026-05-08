import { describe, expect, it } from "vitest";

import { applyPayloadBudget, bucketSeries } from "../bucket-series";

const dayMs = 24 * 60 * 60 * 1000;

function pointsAtOffsets(
  now: Date,
  offsets: number[],
  value: number,
): Array<{ measuredAt: Date; value: number }> {
  return offsets.map((offset) => ({
    measuredAt: new Date(now.getTime() - offset * dayMs),
    value,
  }));
}

describe("bucketSeries()", () => {
  const now = new Date("2026-05-09T12:00:00Z");

  it("buckets the most recent dailyDays as daily means", () => {
    const records = pointsAtOffsets(now, [0, 0, 1, 1, 1, 5, 359], 100);
    const { daily, monthly } = bucketSeries(records, { now });

    // 4 distinct day offsets 0/1/5/359
    expect(daily.map((d) => d.dayOffset)).toEqual([0, 1, 5, 359]);
    expect(daily[0]).toEqual({ dayOffset: 0, value: 100, n: 2 });
    expect(daily[1]).toEqual({ dayOffset: 1, value: 100, n: 3 });
    expect(monthly).toHaveLength(0);
  });

  it("rolls older history into 30-day monthly buckets up to 36 months", () => {
    // dayOffset 360..1080 spans monthOffset 12..35 in the default config.
    const records = pointsAtOffsets(now, [360, 389, 390, 1079, 1080], 50);
    const { daily, monthly } = bucketSeries(records, { now });

    // Day 360 falls into the monthly window — daily empty.
    expect(daily).toHaveLength(0);
    // 360..389 → monthOffset 12, 390..419 → monthOffset 13,
    // 1050..1079 → monthOffset 35, 1080 → out of range.
    const offsets = monthly.map((m) => m.monthOffset);
    expect(offsets).toEqual([12, 13, 35]);
    // 360 and 389 collapse into one bucket
    expect(monthly[0].n).toBe(2);
  });

  it("skips empty buckets entirely", () => {
    const records = pointsAtOffsets(now, [0, 720], 1);
    const { daily, monthly } = bucketSeries(records, { now });
    expect(daily).toHaveLength(1);
    expect(monthly).toHaveLength(1);
  });

  it("ignores future timestamps", () => {
    const records = [
      { measuredAt: new Date(now.getTime() + dayMs), value: 5 },
      { measuredAt: now, value: 5 },
    ];
    const { daily } = bucketSeries(records, { now });
    expect(daily).toHaveLength(1);
    expect(daily[0].dayOffset).toBe(0);
  });

  it("monthOffset labelling is stable regardless of dailyDays", () => {
    // With dailyDays=180, monthOffsetBase shifts to 6.
    const records = pointsAtOffsets(now, [180, 209, 210], 1);
    const { daily, monthly } = bucketSeries(records, { now, dailyDays: 180 });
    expect(daily).toHaveLength(0);
    expect(monthly[0].monthOffset).toBe(6);
    expect(monthly[1].monthOffset).toBe(7);
  });
});

describe("applyPayloadBudget()", () => {
  const now = new Date("2026-05-09T12:00:00Z");

  it("returns the canonical 360+24 bucketing when payload is small", () => {
    const records = pointsAtOffsets(now, [0, 1, 2], 100);
    const result = applyPayloadBudget(records, { now });
    expect(result.daily).toHaveLength(3);
  });

  it("falls back to 180 daily days when the canonical payload exceeds the byte budget", () => {
    // Synthesise enough records to bloat the canonical payload past 1 KB
    // (test budget). 360 unique daily offsets each with 30 samples will
    // serialise to ~30 KB in canonical form.
    const offsets: number[] = [];
    for (let day = 0; day < 360; day++) {
      for (let i = 0; i < 30; i++) offsets.push(day);
    }
    const records = pointsAtOffsets(now, offsets, 12.5);
    const result = applyPayloadBudget(records, { now }, 1_000);
    // Daily window must have shrunk to 180 buckets at most.
    expect(result.daily.length).toBeLessThanOrEqual(180);
  });
});
