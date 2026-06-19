import { describe, it, expect } from "vitest";
import {
  buildMetricSignal,
  placeInBand,
  NORMAL_SWING_K,
} from "@/lib/insights/metric-signal";
import type { GradedSeries } from "@/lib/insights/graded-series";

function graded(partial: Partial<GradedSeries>): GradedSeries {
  return {
    recent: partial.recent ?? [],
    weekly: partial.weekly ?? [],
    monthly: partial.monthly ?? [],
    yearly: partial.yearly ?? [],
  };
}

describe("buildMetricSignal", () => {
  it("returns null when the recent window is empty (no current value)", () => {
    const signal = buildMetricSignal({
      metric: "resting heart rate",
      direction: "lower-better",
      graded: graded({
        monthly: [{ month: "2026-05", min: 60, max: 70, mean: 66, n: 30 }],
      }),
    });
    expect(signal).toBeNull();
  });

  it("computes current, baseline, signed delta and deltaPct from the series", () => {
    const signal = buildMetricSignal({
      metric: "resting heart rate",
      unit: "bpm",
      direction: "lower-better",
      graded: graded({
        recent: [
          { date: "2026-06-01", min: 60, max: 62, mean: 61, n: 1 },
          { date: "2026-06-02", min: 60, max: 62, mean: 61, n: 1 },
        ],
        monthly: [
          { month: "2026-04", min: 64, max: 68, mean: 66, n: 30 },
          { month: "2026-05", min: 64, max: 68, mean: 66, n: 30 },
        ],
      }),
    });
    expect(signal).not.toBeNull();
    expect(signal!.current).toBe(61);
    expect(signal!.baseline).toBe(66);
    expect(signal!.delta).toBe(-5);
    expect(signal!.deltaPct).toBeCloseTo(-7.6, 1);
    expect(signal!.n).toBe(2);
    expect(signal!.unit).toBe("bpm");
    expect(signal!.baselineLabel).toBe("your monthly average");
  });

  it("falls back monthly→weekly→yearly for the baseline", () => {
    const weekly = buildMetricSignal({
      metric: "x",
      direction: "higher-better",
      graded: graded({
        recent: [{ date: "d", min: 10, max: 10, mean: 10, n: 1 }],
        weekly: [{ weekISO: "2026-W20", min: 8, max: 8, mean: 8, n: 7 }],
      }),
    });
    expect(weekly!.baseline).toBe(8);
    expect(weekly!.baselineLabel).toBe("your recent-weeks average");

    const yearly = buildMetricSignal({
      metric: "x",
      direction: "higher-better",
      graded: graded({
        recent: [{ date: "d", min: 10, max: 10, mean: 10, n: 1 }],
        yearly: [
          { year: "2025", min: 6, max: 6, mean: 6, n: 100, slope: null },
        ],
      }),
    });
    expect(yearly!.baseline).toBe(6);
    expect(yearly!.baselineLabel).toBe("your long-term average");
  });

  it("nulls baseline/delta when there is no longer-window history", () => {
    const signal = buildMetricSignal({
      metric: "x",
      direction: "higher-better",
      graded: graded({
        recent: [{ date: "d", min: 10, max: 10, mean: 10, n: 1 }],
      }),
    });
    expect(signal!.baseline).toBeNull();
    expect(signal!.delta).toBeNull();
    expect(signal!.deltaPct).toBeNull();
    expect(signal!.outsideNormalSwing).toBeNull();
    expect(signal!.baselineLabel).toBeUndefined();
  });

  it("flags outsideNormalSwing via |delta| > k·spread", () => {
    // baseline means 60/60/60/60 → spread 0; a non-zero delta is outside.
    const flat = buildMetricSignal({
      metric: "x",
      direction: "lower-better",
      graded: graded({
        recent: [{ date: "d", min: 70, max: 70, mean: 70, n: 1 }],
        monthly: [
          { month: "a", min: 60, max: 60, mean: 60, n: 1 },
          { month: "b", min: 60, max: 60, mean: 60, n: 1 },
        ],
      }),
    });
    expect(flat!.spread).toBe(0);
    expect(flat!.outsideNormalSwing).toBe(true);

    // wide spread swallows a small delta as inside the normal swing.
    const noisy = buildMetricSignal({
      metric: "x",
      direction: "lower-better",
      graded: graded({
        recent: [{ date: "d", min: 62, max: 62, mean: 62, n: 1 }],
        monthly: [
          { month: "a", min: 50, max: 50, mean: 50, n: 1 },
          { month: "b", min: 70, max: 70, mean: 70, n: 1 },
        ],
      }),
    });
    // baseline 60, spread ~14.1, delta 2 → 2 <= 1*14.1 → inside.
    expect(noisy!.outsideNormalSwing).toBe(false);
    expect(NORMAL_SWING_K).toBe(1);
  });

  it("places the current value against a normal range", () => {
    const signal = buildMetricSignal({
      metric: "x",
      direction: "lower-better",
      graded: graded({
        recent: [{ date: "d", min: 110, max: 110, mean: 110, n: 1 }],
        monthly: [{ month: "a", min: 100, max: 100, mean: 100, n: 1 }],
      }),
      normalRange: { low: 60, high: 100 },
      normalRangeSource: "age-sex-adjusted",
    });
    expect(signal!.normalRange).toEqual({
      low: 60,
      high: 100,
      source: "age-sex-adjusted",
    });
    expect(signal!.placement).toBe("above band");
  });
});

describe("placeInBand", () => {
  it("classifies below / in / above", () => {
    expect(placeInBand(50, { low: 60, high: 100 })).toBe("below band");
    expect(placeInBand(80, { low: 60, high: 100 })).toBe("in band");
    expect(placeInBand(120, { low: 60, high: 100 })).toBe("above band");
  });
});
