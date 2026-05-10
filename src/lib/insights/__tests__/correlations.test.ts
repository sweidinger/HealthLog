import { describe, it, expect } from "vitest";
import {
  pearson,
  weekdayAnova,
  correlateBpCompliance,
  correlateMoodPulse,
  correlateWeightWeekday,
  MIN_PAIRED_N,
  MAX_P_VALUE,
} from "../correlations";

/**
 * v1.4.20 phase B3 — correlation discovery.
 *
 * Three pre-defined hypotheses are surfaced as `<CorrelationCard>` rows.
 * Quality bar is non-negotiable: n >= 14, p < 0.05. Anything below
 * returns `status: "insufficient"` so the card paints an EmptyState.
 */

function makeDate(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

// ── pearson() ───────────────────────────────────────────────────────

describe("pearson", () => {
  it("flags too_few_pairs below the minimum n", () => {
    const xs = [1, 2, 3];
    const ys = [1, 2, 3];
    const result = pearson({ xs, ys });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_pairs");
      expect(result.n).toBe(3);
    }
  });

  it("flags no_variance when one column is constant", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = Array.from({ length: 20 }, () => 7);
    const result = pearson({ xs, ys });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_variance");
    }
  });

  it("returns r near +1 for a perfect positive linear relation", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => 2 * x + 5);
    const result = pearson({ xs, ys });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.r).toBeCloseTo(1, 2);
      expect(result.pValue).toBeLessThan(0.001);
    }
  });

  it("returns r near -1 for a perfect negative linear relation", () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => -3 * x + 10);
    const result = pearson({ xs, ys });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.r).toBeCloseTo(-1, 2);
      expect(result.pValue).toBeLessThan(0.001);
    }
  });

  it("returns r near 0 for noise, with p above the surface threshold", () => {
    // Deterministic noise (no Math.random) so the test is reproducible.
    const xs = [
      0.1, 0.5, 0.9, 0.2, 0.7, 0.4, 0.6, 0.3, 0.8, 0.05, 0.95, 0.15, 0.85, 0.55,
      0.25,
    ];
    const ys = [
      0.5, 0.1, 0.7, 0.3, 0.2, 0.9, 0.4, 0.6, 0.05, 0.95, 0.85, 0.55, 0.25,
      0.45, 0.65,
    ];
    const result = pearson({ xs, ys });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(Math.abs(result.r)).toBeLessThan(0.5);
      // Either p is high (no support) or low — but for these specific
      // jittered values we expect no significance.
      expect(result.pValue).toBeGreaterThan(MAX_P_VALUE);
    }
  });
});

// ── weekdayAnova() ──────────────────────────────────────────────────

describe("weekdayAnova", () => {
  it("flags too_few_pairs when total n < 14", () => {
    const result = weekdayAnova([
      { weekday: 0, value: 80 },
      { weekday: 1, value: 81 },
    ]);
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_pairs");
    }
  });

  it("flags no_variance when every weekday has identical values", () => {
    const data = Array.from({ length: 21 }, (_, i) => ({
      weekday: i % 7,
      value: 80,
    }));
    const result = weekdayAnova(data);
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_variance");
    }
  });

  it("flags Monday outlier when Monday weights spike", () => {
    // Three weeks of "boring" weekdays (~80 kg) plus a Monday spike (~84 kg).
    const data: Array<{ weekday: number; value: number }> = [];
    for (let week = 0; week < 4; week++) {
      data.push({ weekday: 0, value: 84.0 + (week % 2) * 0.1 });
      data.push({ weekday: 1, value: 80.0 + week * 0.05 });
      data.push({ weekday: 2, value: 80.1 - week * 0.05 });
      data.push({ weekday: 3, value: 80.2 });
      data.push({ weekday: 4, value: 80.0 });
      data.push({ weekday: 5, value: 80.1 });
      data.push({ weekday: 6, value: 80.0 });
    }
    const result = weekdayAnova(data);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.outlierIndex).toBe(0);
      expect(result.pValue).toBeLessThan(MAX_P_VALUE);
      expect(result.etaSquared).toBeGreaterThan(0.14);
    }
  });
});

// ── correlateBpCompliance() ─────────────────────────────────────────

describe("correlateBpCompliance", () => {
  function buildPairs(rows: Array<[number, number]>) {
    return rows.map(([compliancePct, systolic], i) => ({
      date: makeDate(rows.length - i),
      compliancePct,
      systolic,
    }));
  }

  it("returns insufficient (too_few_pairs) at n=13", () => {
    const daily = buildPairs(
      Array.from(
        { length: 13 },
        (_, i) => [50 + i * 4, 150 - i * 2] as [number, number],
      ),
    );
    const result = correlateBpCompliance({ daily });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_pairs");
      expect(result.n).toBe(13);
    }
  });

  it("returns ok with negative r for strong compliance↔BP support", () => {
    const daily = buildPairs(
      Array.from(
        { length: 20 },
        (_, i) => [50 + i * 2.5, 150 - i * 1.5] as [number, number],
      ),
    );
    const result = correlateBpCompliance({ daily });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.statistic).toBeLessThan(-0.9);
      expect(result.pValue).toBeLessThan(MAX_P_VALUE);
      expect(result.n).toBe(20);
      expect(result.interpretation).toMatch(/pattern worth watching/i);
      expect(result.interpretation).not.toMatch(/causes?/i);
      expect(result.confidenceBand.label).toBeDefined();
    }
  });

  it("returns insufficient (not_significant) when r is near zero", () => {
    // Deterministic jitter, n large enough — but no relation.
    const daily = buildPairs([
      [50, 130],
      [55, 135],
      [60, 128],
      [70, 138],
      [80, 132],
      [90, 130],
      [100, 134],
      [55, 132],
      [65, 130],
      [75, 134],
      [85, 132],
      [95, 130],
      [60, 132],
      [70, 130],
      [80, 134],
      [90, 132],
      [50, 132],
      [60, 130],
      [70, 132],
      [80, 132],
    ]);
    const result = correlateBpCompliance({ daily });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("not_significant");
    }
  });
});

// ── correlateMoodPulse() ────────────────────────────────────────────

describe("correlateMoodPulse", () => {
  it("returns ok with negative r for low-mood high-pulse pattern", () => {
    const daily = Array.from({ length: 20 }, (_, i) => ({
      date: makeDate(20 - i),
      mood: 1 + (i % 5),
      restingPulse: 80 - (i % 5) * 3,
    }));
    const result = correlateMoodPulse({ daily });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.statistic).toBeLessThan(0);
      expect(result.pValue).toBeLessThan(MAX_P_VALUE);
      expect(result.interpretation).toMatch(
        /pattern worth watching|do not move/i,
      );
    }
  });

  it("returns insufficient at n below threshold", () => {
    const daily = Array.from({ length: MIN_PAIRED_N - 1 }, (_, i) => ({
      date: makeDate(i),
      mood: 3,
      restingPulse: 70,
    }));
    const result = correlateMoodPulse({ daily });
    expect(result.status).toBe("insufficient");
  });
});

// ── correlateWeightWeekday() ────────────────────────────────────────

describe("correlateWeightWeekday", () => {
  it("flags Monday spike with conservative interpretation", () => {
    const daily: Array<{ weekday: number; weight: number }> = [];
    for (let week = 0; week < 4; week++) {
      daily.push({ weekday: 0, weight: 84.0 + week * 0.1 });
      daily.push({ weekday: 1, weight: 80.0 });
      daily.push({ weekday: 2, weight: 80.1 });
      daily.push({ weekday: 3, weight: 80.2 });
      daily.push({ weekday: 4, weight: 80.0 });
      daily.push({ weekday: 5, weight: 80.1 });
      daily.push({ weekday: 6, weight: 80.0 });
    }
    const result = correlateWeightWeekday({ daily });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.interpretation).toMatch(/Monday/);
      expect(result.interpretation).toMatch(/pattern worth watching/i);
      expect(result.interpretation).not.toMatch(/causes?/i);
      expect(result.pValue).toBeLessThan(MAX_P_VALUE);
    }
  });

  it("returns insufficient when no weekday meaningfully differs", () => {
    const daily = Array.from({ length: 28 }, (_, i) => ({
      weekday: i % 7,
      weight: 80 + (i % 2 === 0 ? 0.05 : -0.05),
    }));
    const result = correlateWeightWeekday({ daily });
    expect(result.status).toBe("insufficient");
  });

  it("returns insufficient at n below threshold", () => {
    const daily = Array.from({ length: 10 }, (_, i) => ({
      weekday: i % 7,
      weight: 80 + i * 0.5,
    }));
    const result = correlateWeightWeekday({ daily });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_pairs");
    }
  });
});
