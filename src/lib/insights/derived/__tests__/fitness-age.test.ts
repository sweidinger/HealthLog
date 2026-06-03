import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import {
  computeFitnessAge,
  placeVo2Band,
  fitnessAgeDeltaYears,
} from "../fitness-age";

const NOW = new Date("2026-06-02T07:00:00Z");
const MALE_40 = { ageYears: 40, sex: "MALE" as const };
const NO_DEMO = { ageYears: null, sex: null };

beforeEach(() => vi.clearAllMocks());

describe("placeVo2Band", () => {
  // FRIEND 40–49 male band is { low: 35, high: 45 }.
  it("green at/above the reference high", () => {
    expect(placeVo2Band(46, { low: 35, high: 45 })).toBe("green");
    expect(placeVo2Band(45, { low: 35, high: 45 })).toBe("green");
  });
  it("yellow inside the band", () => {
    expect(placeVo2Band(40, { low: 35, high: 45 })).toBe("yellow");
  });
  it("red below the band low", () => {
    expect(placeVo2Band(30, { low: 35, high: 45 })).toBe("red");
  });
  it("null without a reference", () => {
    expect(placeVo2Band(40, null)).toBeNull();
  });
});

describe("fitnessAgeDeltaYears", () => {
  it("fitter-than-midpoint reads as negative (younger) years", () => {
    // midpoint 40; 45 → -5
    expect(fitnessAgeDeltaYears(45, { low: 35, high: 45 })).toBe(-5);
  });
  it("below-midpoint reads as positive (older) years", () => {
    expect(fitnessAgeDeltaYears(35, { low: 35, high: 45 })).toBe(5);
  });
  it("null without a reference", () => {
    expect(fitnessAgeDeltaYears(40, null)).toBeNull();
  });
});

describe("computeFitnessAge", () => {
  it("insufficient when no VO2max reading exists", async () => {
    findMany.mockResolvedValueOnce([]);
    const r = await computeFitnessAge("u1", MALE_40, { now: NOW });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") expect(r.reason).toBe("no_readings_in_window");
  });

  it("ok with a band + fitness-age delta when demographics are present", async () => {
    findMany.mockResolvedValueOnce([{ value: 46 }, { value: 44 }, { value: 43 }]);
    const r = await computeFitnessAge("u1", MALE_40, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.vo2Max).toBe(46);
      // Age 40 sits between the 30s (centre 34.5 → {39,49}) and 40s (centre
      // 44.5 → {35,45}) VO2max bands; the fractional-age lookup interpolates
      // to {36.8, 46.8} rather than reading the flat 40s bracket.
      expect(r.value.referenceBand).toEqual({ low: 36.8, high: 46.8 });
      // 46 < the interpolated upper edge (46.8) → not "excellent" green.
      expect(r.value.band).toBe("yellow");
      // ≥3 readings → trend = 46 - 44 = 2
      expect(r.value.trendDelta).toBe(2);
      // midpoint 41.8, 46 → -round(4.2) = -4
      expect(r.value.fitnessAgeDeltaYears).toBe(-4);
    }
  });

  it("ok but band/delta null without demographics; trend suppressed under 3 readings", async () => {
    findMany.mockResolvedValueOnce([{ value: 42 }, { value: 40 }]);
    const r = await computeFitnessAge("u1", NO_DEMO, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.band).toBeNull();
      expect(r.value.fitnessAgeDeltaYears).toBeNull();
      expect(r.value.trendDelta).toBeNull();
    }
  });
});
