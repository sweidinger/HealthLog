import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const findFirst = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: (...a: unknown[]) => findMany(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
  },
}));

import {
  computeSixMinuteWalkBand,
  placeSixMinuteWalkBand,
} from "../six-minute-walk";

const NOW = new Date("2026-06-02T07:00:00Z");
// Enright male, 40 yr, 180 cm, 80 kg →
//   7.57·180 − 5.02·40 − 1.76·80 − 309 = 712 m predicted.
const MALE_40 = { ageYears: 40, sex: "MALE" as const, heightCm: 180 };
const NO_DEMO = { ageYears: null, sex: null, heightCm: null };
const NO_WEIGHT_PROFILE = MALE_40;

beforeEach(() => vi.clearAllMocks());

describe("placeSixMinuteWalkBand", () => {
  it("green at/above 80% of predicted", () => {
    expect(placeSixMinuteWalkBand(80)).toBe("green");
    expect(placeSixMinuteWalkBand(100)).toBe("green");
  });
  it("yellow between 60 and 80%", () => {
    expect(placeSixMinuteWalkBand(60)).toBe("yellow");
    expect(placeSixMinuteWalkBand(79)).toBe("yellow");
  });
  it("red below 60%", () => {
    expect(placeSixMinuteWalkBand(59)).toBe("red");
  });
  it("null without a percent", () => {
    expect(placeSixMinuteWalkBand(null)).toBeNull();
  });
});

describe("computeSixMinuteWalkBand", () => {
  it("insufficient when no 6MWT reading exists", async () => {
    findMany.mockResolvedValueOnce([]);
    const r = await computeSixMinuteWalkBand("u1", MALE_40, { now: NOW });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.reason).toBe("no_readings_in_window");
    }
    // No reading → never reach the weight read.
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("ok with a band + percent-of-predicted when full demographics + weight exist", async () => {
    // 3 readings → trend = 712 - 700 = 12; distance 712 vs predicted 712 → 100%.
    findMany.mockResolvedValueOnce([
      { value: 712 },
      { value: 700 },
      { value: 690 },
    ]);
    findFirst.mockResolvedValueOnce({ value: 80 });
    const r = await computeSixMinuteWalkBand("u1", MALE_40, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.distanceM).toBe(712);
      expect(r.value.predictedM).toBe(712);
      expect(r.value.percentOfPredicted).toBe(100);
      expect(r.value.band).toBe("green");
      expect(r.value.trendDelta).toBe(12);
    }
  });

  it("bands red on a low percent of predicted", async () => {
    // 400 / 712 = 56% → red.
    findMany.mockResolvedValueOnce([{ value: 400 }]);
    findFirst.mockResolvedValueOnce({ value: 80 });
    const r = await computeSixMinuteWalkBand("u1", MALE_40, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.percentOfPredicted).toBe(56);
      expect(r.value.band).toBe("red");
    }
  });

  it("ok but band/percent null without demographics", async () => {
    findMany.mockResolvedValueOnce([{ value: 500 }]);
    findFirst.mockResolvedValueOnce({ value: 80 });
    const r = await computeSixMinuteWalkBand("u1", NO_DEMO, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.distanceM).toBe(500);
      expect(r.value.predictedM).toBeNull();
      expect(r.value.percentOfPredicted).toBeNull();
      expect(r.value.band).toBeNull();
      // Single reading → trend suppressed.
      expect(r.value.trendDelta).toBeNull();
    }
  });

  it("ok but band null when weight is absent (no fabricated placement)", async () => {
    findMany.mockResolvedValueOnce([{ value: 600 }]);
    findFirst.mockResolvedValueOnce(null); // no recent weight
    const r = await computeSixMinuteWalkBand("u1", NO_WEIGHT_PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.distanceM).toBe(600);
      expect(r.value.predictedM).toBeNull();
      expect(r.value.percentOfPredicted).toBeNull();
      expect(r.value.band).toBeNull();
    }
  });
});
