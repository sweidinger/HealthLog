import { describe, it, expect } from "vitest";
import { computeConfidence, type ConfidenceInputs } from "../confidence";

/**
 * v1.4.16 phase B5d — `computeConfidence()` deterministic scorer.
 *
 * The wrapper feeds three inputs:
 *   - n: sample count behind the cited data window
 *     (from `metricSource.n` when available; 0 otherwise).
 *   - recencyDays: days since the most recent sample in the window.
 *   - deviationStdRatio: |deviation| / stdev of the user's 90-day
 *     baseline. `null` when the baseline is too thin to compute.
 *
 * Score breakdown (max 100):
 *   - n contribution: log-saturating curve, max 40 at n=30 ish.
 *     n<3 hard-caps the whole score at ≤15 (5 * n).
 *   - recencyScore: 30 at <2d, decays linearly to 0 at 30d, floored at 0.
 *   - signalScore: 30 at |z|≥1.5, 0 at z=0, 15 when ratio is null.
 *
 * 12 fixtures cover the input matrix per research §2.C: small-n hard
 * cap, mid-n + recency interplay, saturated-n + signal extremes,
 * null-ratio neutral path.
 */

interface Fixture {
  name: string;
  inputs: ConfidenceInputs;
  expected: number;
}

const FIXTURES: Fixture[] = [
  // n hard-cap: n<3 always returns max(10, 5*n)
  {
    name: "n=0 → hard-cap 10 floor",
    inputs: { n: 0, recencyDays: 0, deviationStdRatio: 2 },
    expected: 10,
  },
  {
    name: "n=1 → hard-cap 10 floor",
    inputs: { n: 1, recencyDays: 0, deviationStdRatio: 2 },
    expected: 10,
  },
  {
    name: "n=2 → hard-cap 10 (5*2)",
    inputs: { n: 2, recencyDays: 0, deviationStdRatio: 2 },
    expected: 10,
  },
  // n=3: nScore = 10 + 10*log10(3) ≈ 14.77;
  // recency=1 → 30 * (1 - 1/30) = 29; signal=null → 15
  // total ≈ 14.77 + 29 + 15 = 58.77 → 59
  {
    name: "n=3 fresh sample (1d old), null ratio → 59",
    inputs: { n: 3, recencyDays: 1, deviationStdRatio: null },
    expected: 59,
  },
  // n=14, recencyDays=1, ratio=2 → research-§2C calibration target ~94
  // nScore = 10 + 10*log10(14) ≈ 21.46
  // recencyScore = 30 * (1 - 1/30) = 29
  // signalScore = min(30, 30 * 2/1.5) = 30
  // total ≈ 80.46 → 80
  {
    name: "n=14, fresh, strong signal → ~80",
    inputs: { n: 14, recencyDays: 1, deviationStdRatio: 2 },
    expected: 80,
  },
  // n=30, recencyDays=20, null ratio → research-§2C calibration target ~52
  // nScore = min(40, 10 + 10*log10(30)) = min(40, 24.77) = 24.77
  // recencyScore = max(0, 30 * (1 - 20/30)) = 10
  // signalScore = 15 (null)
  // total ≈ 49.77 → 50
  {
    name: "n=30, stale (20d), null ratio → ~50",
    inputs: { n: 30, recencyDays: 20, deviationStdRatio: null },
    expected: 50,
  },
  // n=100 → nScore = min(40, 10 + 10*log10(100)) = 30 (curve, not cap)
  // recency=0 → 30, signal=z=1.5 → 30, total 90
  {
    name: "n=100, fresh, strong signal → 90",
    inputs: { n: 100, recencyDays: 0, deviationStdRatio: 1.5 },
    expected: 90,
  },
  // n=10000 → log10 saturates at the 40 cap → max possible total 100
  {
    name: "n=10000 saturates the n curve at 40 → 100",
    inputs: { n: 10000, recencyDays: 0, deviationStdRatio: 2 },
    expected: 100,
  },
  // n=10, recency=30d → recency floors at 0; ratio=0 → signal=0
  // nScore = 10 + 10*log10(10) = 20; recency=0; signal=0
  // total = 20
  {
    name: "n=10, ancient (30d), zero deviation → 20",
    inputs: { n: 10, recencyDays: 30, deviationStdRatio: 0 },
    expected: 20,
  },
  // n=10, recency=45d → recencyScore floor 0 (negative clamped)
  {
    name: "n=10, very ancient (45d) clamps recency to 0",
    inputs: { n: 10, recencyDays: 45, deviationStdRatio: null },
    expected: 35, // 20 + 0 + 15
  },
  // n=20, fresh, mild signal (z=0.75 → half of cap)
  // nScore = 10 + 10*log10(20) ≈ 23.01
  // recency=0 → 30
  // signal = 30 * 0.75/1.5 = 15
  // total ≈ 68.01 → 68
  {
    name: "n=20, fresh, mild signal → ~68",
    inputs: { n: 20, recencyDays: 0, deviationStdRatio: 0.75 },
    expected: 68,
  },
  // Negative ratio: |z|=2 still hits cap of 30
  {
    name: "n=14, fresh, strong negative signal (z=-2) → 80",
    inputs: { n: 14, recencyDays: 1, deviationStdRatio: -2 },
    expected: 80,
  },
  // Edge: n=2, fresh, strong signal — hard-cap still applies
  {
    name: "n=2 hard-cap survives even with strong signal + fresh",
    inputs: { n: 2, recencyDays: 0, deviationStdRatio: 2 },
    expected: 10,
  },
];

describe("computeConfidence()", () => {
  it.each(FIXTURES)("$name", ({ inputs, expected }) => {
    expect(computeConfidence(inputs)).toBe(expected);
  });

  it("returns an integer in [0, 100] for all fixtures", () => {
    for (const f of FIXTURES) {
      const v = computeConfidence(f.inputs);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("is monotonic in n when other inputs fixed (more data → never lower)", () => {
    const baseInputs = { recencyDays: 1, deviationStdRatio: 1 };
    let prev = -Infinity;
    for (const n of [5, 10, 20, 50, 100]) {
      const v = computeConfidence({ ...baseInputs, n });
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
