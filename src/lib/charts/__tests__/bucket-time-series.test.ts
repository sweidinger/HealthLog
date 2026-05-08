import { describe, expect, it } from "vitest";

import {
  bucketTimeSeries,
  pickBucket,
  type BucketInputPoint,
} from "../bucket-time-series";

const dayMs = 24 * 60 * 60 * 1000;

function dailyAt(start: Date, day: number, value: number): BucketInputPoint {
  return {
    timestamp: start.getTime() + day * dayMs,
    values: { weight: value },
  };
}

describe("pickBucket()", () => {
  it.each([
    [0, "day"],
    [1, "day"],
    [90, "day"],
    [91, "week"],
    [365, "week"],
    [730, "week"],
    [731, "month"],
    [1500, "month"],
  ])("range %d days -> %s", (range, expected) => {
    expect(pickBucket(range)).toBe(expected);
  });
});

describe("bucketTimeSeries()", () => {
  const start = new Date("2025-01-06T00:00:00Z"); // Monday

  it("preserves daily granularity for ranges <= 90 days", () => {
    const points = [0, 1, 2, 30, 89].map((d) => dailyAt(start, d, 80 + d));
    const result = bucketTimeSeries(points);
    expect(result.bucket).toBe("day");
    expect(result.points).toHaveLength(5);
  });

  it("rolls 91-730 days into ISO weekly buckets", () => {
    // 200-day window with one observation per day → ~28 weekly buckets.
    const points = Array.from({ length: 200 }, (_, i) =>
      dailyAt(start, i, 80 + (i % 5)),
    );
    const result = bucketTimeSeries(points);
    expect(result.bucket).toBe("week");
    // 200 / 7 ≈ 28.5 — first/last weeks may be partial → 29 distinct keys.
    expect(result.points.length).toBeGreaterThanOrEqual(28);
    expect(result.points.length).toBeLessThanOrEqual(30);
    // Means must use only days that had data (no zero-pad).
    expect(
      result.points.every((p) => Object.values(p.values).every((v) => v >= 80)),
    ).toBe(true);
  });

  it("rolls > 730 days into Berlin-calendar monthly buckets", () => {
    // 800 daily points, value = 100.
    const points = Array.from({ length: 800 }, (_, i) =>
      dailyAt(start, i, 100),
    );
    const result = bucketTimeSeries(points);
    expect(result.bucket).toBe("month");
    // ~26 calendar months
    expect(result.points.length).toBeGreaterThanOrEqual(25);
    expect(result.points.length).toBeLessThanOrEqual(28);
    // Mean of constant series stays constant.
    expect(result.points.every((p) => p.values.weight === 100)).toBe(true);
    // Counts add up to 800.
    const total = result.points.reduce((sum, p) => sum + p.counts.weight, 0);
    expect(total).toBe(800);
  });

  it("skips empty buckets entirely (no zero-baseline)", () => {
    // Two days far apart; the gap weeks must not appear.
    const points: BucketInputPoint[] = [
      { timestamp: start.getTime(), values: { weight: 80 } },
      { timestamp: start.getTime() + 200 * dayMs, values: { weight: 90 } },
    ];
    const result = bucketTimeSeries(points, { bucket: "week" });
    expect(result.points).toHaveLength(2);
    expect(result.points.map((p) => p.values.weight)).toEqual([80, 90]);
  });

  it("handles multiple metrics independently", () => {
    const points: BucketInputPoint[] = [
      { timestamp: start.getTime(), values: { sys: 130, dia: 80 } },
      { timestamp: start.getTime() + dayMs, values: { sys: 140 } }, // dia missing
      { timestamp: start.getTime() + 2 * dayMs, values: { dia: 78 } }, // sys missing
    ];
    const result = bucketTimeSeries(points, { bucket: "week" });
    expect(result.points).toHaveLength(1);
    const point = result.points[0];
    expect(point.counts.sys).toBe(2);
    expect(point.counts.dia).toBe(2);
    expect(point.values.sys).toBe(135); // (130+140)/2
    expect(point.values.dia).toBe(79); // (80+78)/2
  });

  it("respects the explicit bucket override", () => {
    const points = [0, 1, 2].map((d) => dailyAt(start, d, 80));
    const result = bucketTimeSeries(points, { bucket: "month" });
    expect(result.bucket).toBe("month");
    expect(result.points).toHaveLength(1);
  });
});
