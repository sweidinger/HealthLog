/**
 * v1.15.12 A1 — unit pins for the graded BP pillar score.
 *
 * The maintainer's apps01 profile (under-65 ceiling 129/79, avg 134/87)
 * is the canonical regression: the binary all-time in-target rate read
 * ~10-16/100; the graded score must land in the borderline-stage-1 band
 * (low-to-mid 50s), not in the catastrophic band.
 */
import { describe, expect, it } from "vitest";
import {
  gradeBpScore,
  gradeBpScoreFromSeries,
  type BpPairPoint,
} from "../bp-grade";
import type { BpTargets } from "../bp-targets";

// Under-65 ESH band — the maintainer's age band.
const UNDER65: BpTargets = {
  sysLow: 120,
  sysHigh: 129,
  diaLow: 70,
  diaHigh: 79,
};

describe("gradeBpScore", () => {
  it("grades the maintainer's 134/87 into the borderline band [45,60]", () => {
    const score = gradeBpScore({ sys: 134, dia: 87, target: UNDER65 });
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThanOrEqual(60);
  });

  it("grades a well-controlled 120/78 at or above 85", () => {
    expect(
      gradeBpScore({ sys: 120, dia: 78, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(85);
  });

  it("grades a textbook-normal 118/76 very high (≈100)", () => {
    expect(
      gradeBpScore({ sys: 118, dia: 76, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(88);
  });

  it("grades an uncontrolled 160/100 at or below 30", () => {
    expect(
      gradeBpScore({ sys: 160, dia: 100, target: UNDER65 }),
    ).toBeLessThanOrEqual(30);
  });

  it("takes the WORSE axis — a single high diastolic drags the score down", () => {
    // sys perfect (118), dia far over (95): the worst axis should win.
    const sysOk = gradeBpScore({ sys: 118, dia: 78, target: UNDER65 });
    const diaHigh = gradeBpScore({ sys: 118, dia: 95, target: UNDER65 });
    expect(diaHigh).toBeLessThan(sysOk);
  });

  it("is monotonic — higher BP never scores better", () => {
    const a = gradeBpScore({ sys: 130, dia: 82, target: UNDER65 });
    const b = gradeBpScore({ sys: 140, dia: 88, target: UNDER65 });
    const c = gradeBpScore({ sys: 150, dia: 95, target: UNDER65 });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("has no cliff — a one-mmHg change moves the score by a small amount", () => {
    const at = gradeBpScore({ sys: 129, dia: 79, target: UNDER65 });
    const justOver = gradeBpScore({ sys: 130, dia: 79, target: UNDER65 });
    expect(at - justOver).toBeLessThanOrEqual(5);
    expect(at).toBeGreaterThanOrEqual(justOver);
  });

  it("penalises hypotension symmetrically (below the clinical floor)", () => {
    // 85/45 is below both floors (sys 90 / dia 50) — should not read ~100.
    const low = gradeBpScore({ sys: 85, dia: 45, target: UNDER65 });
    expect(low).toBeLessThan(85);
  });
});

describe("gradeBpScoreFromSeries", () => {
  const NOW = new Date("2026-06-07T12:00:00.000Z");
  const daysAgo = (n: number): Date =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it("returns null for an empty series", () => {
    expect(
      gradeBpScoreFromSeries({ pairs: [], target: UNDER65, now: NOW }),
    ).toBeNull();
  });

  it("weights recent readings more — recent improvement lifts the score", () => {
    // Old readings high, recent readings well-controlled.
    const pairs: BpPairPoint[] = [
      { at: daysAgo(300), sys: 160, dia: 100 },
      { at: daysAgo(280), sys: 158, dia: 98 },
      { at: daysAgo(5), sys: 120, dia: 76 },
      { at: daysAgo(2), sys: 119, dia: 75 },
      { at: daysAgo(0), sys: 121, dia: 77 },
    ];
    const recencyWeighted = gradeBpScoreFromSeries({
      pairs,
      target: UNDER65,
      now: NOW,
    });
    // A flat (unweighted) mean would be dragged toward ~145/90; the
    // recency-weighted representative should read close to the recent
    // well-controlled cluster.
    expect(recencyWeighted).not.toBeNull();
    expect(recencyWeighted as number).toBeGreaterThanOrEqual(80);
  });

  it("matches the single-reading grade when every pair is today", () => {
    const pairs: BpPairPoint[] = [
      { at: NOW, sys: 134, dia: 87 },
      { at: NOW, sys: 134, dia: 87 },
    ];
    expect(
      gradeBpScoreFromSeries({ pairs, target: UNDER65, now: NOW }),
    ).toBe(gradeBpScore({ sys: 134, dia: 87, target: UNDER65 }));
  });
});
