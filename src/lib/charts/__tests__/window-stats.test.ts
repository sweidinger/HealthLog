import { describe, it, expect } from "vitest";

import { computeWindowStats } from "@/lib/charts/window-stats";

describe("computeWindowStats", () => {
  it("computes min / max / median / mean over an odd-length series", () => {
    const stats = computeWindowStats([3, 1, 2]);
    expect(stats).toEqual({
      count: 3,
      min: 1,
      max: 3,
      median: 2,
      mean: 2,
    });
  });

  it("uses the linear-interpolated midpoint on an even-length series", () => {
    // Matches the PERCENTILE_CONT(0.5) definition `summarize()` uses.
    const stats = computeWindowStats([1, 2, 3, 4]);
    expect(stats.median).toBe(2.5);
    expect(stats.mean).toBe(2.5);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
    expect(stats.count).toBe(4);
  });

  it("drops non-finite / gap entries before the fold", () => {
    const stats = computeWindowStats([
      10,
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      20,
    ]);
    expect(stats.count).toBe(2);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(20);
    expect(stats.mean).toBe(15);
    expect(stats.median).toBe(15);
  });

  it("returns the all-null shape for an empty or all-gap window", () => {
    for (const input of [[], [undefined, null, Number.NaN]]) {
      const stats = computeWindowStats(input as Array<number | null>);
      expect(stats).toEqual({
        count: 0,
        min: null,
        max: null,
        median: null,
        mean: null,
      });
    }
  });

  it("summarises a single-point window without dividing by zero", () => {
    const stats = computeWindowStats([42]);
    expect(stats).toEqual({
      count: 1,
      min: 42,
      max: 42,
      median: 42,
      mean: 42,
    });
  });
});
