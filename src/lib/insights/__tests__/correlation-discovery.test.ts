import { describe, it, expect } from "vitest";

import {
  discoverCorrelations,
  lagJoin,
  benjaminiHochberg,
  type DailySeriesPoint,
  type NamedSeries,
} from "../correlation-discovery";

/** Build a contiguous daily series from day-1 of a month. */
function series(values: number[], startDay = 1): DailySeriesPoint[] {
  return values.map((value, i) => ({
    day: `2026-03-${String(startDay + i).padStart(2, "0")}`,
    value,
  }));
}

describe("lagJoin", () => {
  it("pairs a behaviour day with the next day's outcome", () => {
    const behaviour = series([1, 2, 3]); // Mar 1,2,3
    const outcome = series([10, 20, 30]); // Mar 1,2,3
    const { xs, ys } = lagJoin(behaviour, outcome, 1);
    // Mar1→Mar2 (1,20), Mar2→Mar3 (2,30); Mar3→Mar4 has no outcome.
    expect(xs).toEqual([1, 2]);
    expect(ys).toEqual([20, 30]);
  });
});

describe("benjaminiHochberg", () => {
  it("adjusts p-values monotonically and never exceeds 1", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.5]);
    expect(q.every((v) => v <= 1 && v >= 0)).toBe(true);
    // Smallest p gets the smallest q under the monotone step-up.
    expect(q[0]).toBeLessThanOrEqual(q[1]);
  });

  it("controls discovery — a single tiny p stays significant, noise inflates", () => {
    // 1 true (p=0.001) + 19 noise (p≈0.5): BH keeps the true one well under q.
    const ps = [0.001, ...Array.from({ length: 19 }, () => 0.5)];
    const q = benjaminiHochberg(ps);
    expect(q[0]).toBeLessThan(0.05);
    expect(q[1]).toBeGreaterThan(0.1);
  });
});

describe("discoverCorrelations", () => {
  it("returns none when no pair clears the n ≥ 20 gate", () => {
    const behaviours: NamedSeries[] = [
      { key: "MOOD", role: "behaviour", points: series([3, 4, 5]) },
    ];
    const outcomes: NamedSeries[] = [
      { key: "SLEEP_DURATION", role: "outcome", points: series([400, 410, 420]) },
    ];
    const result = discoverCorrelations([...behaviours, ...outcomes]);
    expect(result.discovered).toHaveLength(0);
    expect(result.pairsTested).toBe(0);
  });

  it("surfaces a strong lagged pair and tags n, r, p, q", () => {
    // 30 days: outcome[d+1] tracks behaviour[d] linearly → strong r.
    const n = 30;
    const behaviourVals = Array.from({ length: n }, (_, i) => i + (i % 3));
    // Outcome on day d+1 mirrors behaviour on day d (shift by one).
    const outcomeVals = [0, ...behaviourVals.slice(0, n - 1).map((v) => v * 2 + 5)];
    const result = discoverCorrelations(
      [
        { key: "TIME_IN_DAYLIGHT", role: "behaviour", points: series(behaviourVals) },
        { key: "SLEEP_DURATION", role: "outcome", points: series(outcomeVals) },
      ],
      { fdrQ: 0.1 },
    );
    expect(result.pairsTested).toBe(1);
    expect(result.discovered).toHaveLength(1);
    const pair = result.discovered[0];
    expect(pair.behaviour).toBe("TIME_IN_DAYLIGHT");
    expect(pair.outcome).toBe("SLEEP_DURATION");
    expect(pair.n).toBeGreaterThanOrEqual(20);
    expect(pair.pValue).toBeLessThan(0.05);
    expect(pair.qValue).toBeLessThanOrEqual(0.1);
    expect(pair.interpretation).toMatch(/not a cause/);
    expect(pair.lagDays).toBe(1);
  });

  it("drops a pure-noise pair under FDR control", () => {
    // 30 days of independent-ish noise → no defensible correlation.
    const noiseA = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 10 + 50);
    const noiseB = Array.from({ length: 30 }, (_, i) => Math.cos(i * 1.7) * 10 + 50);
    const result = discoverCorrelations([
      { key: "BLOOD_GLUCOSE", role: "behaviour", points: series(noiseA) },
      { key: "WEIGHT", role: "outcome", points: series(noiseB) },
    ]);
    // It is tested (n ≥ 20) but should not survive p < 0.05 + FDR.
    expect(result.pairsTested).toBe(1);
    expect(result.discovered).toHaveLength(0);
  });
});
