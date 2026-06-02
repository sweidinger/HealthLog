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

import { computeVascularAgeDelta, placeVascularBand } from "../vascular-age";

const NOW = new Date("2026-06-02T07:00:00Z");
const AGE_40 = { ageYears: 40, sex: "MALE" as const };
const NO_AGE = { ageYears: null, sex: null };

beforeEach(() => vi.clearAllMocks());

describe("placeVascularBand", () => {
  it("green when ≥2 years below chronological", () => {
    expect(placeVascularBand(-3)).toBe("green");
    expect(placeVascularBand(-2)).toBe("green");
  });
  it("yellow within ±2 years", () => {
    expect(placeVascularBand(0)).toBe("yellow");
    expect(placeVascularBand(1)).toBe("yellow");
  });
  it("red when ≥2 years above", () => {
    expect(placeVascularBand(3)).toBe("red");
  });
  it("null without a delta", () => {
    expect(placeVascularBand(null)).toBeNull();
  });
});

describe("computeVascularAgeDelta", () => {
  it("insufficient when no vascular-age reading", async () => {
    findMany.mockResolvedValueOnce([]);
    findFirst.mockResolvedValueOnce(null);
    const r = await computeVascularAgeDelta("u1", AGE_40, { now: NOW });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") expect(r.reason).toBe("no_readings_in_window");
  });

  it("ok with delta + band + PWV context; trend with ≥3 readings", async () => {
    findMany.mockResolvedValueOnce([{ value: 36 }, { value: 38 }, { value: 39 }]);
    findFirst.mockResolvedValueOnce({ value: 7.2 });
    const r = await computeVascularAgeDelta("u1", AGE_40, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.vascularAge).toBe(36);
      expect(r.value.deltaYears).toBe(-4); // 36 - 40
      expect(r.value.band).toBe("green");
      expect(r.value.pulseWaveVelocity).toBe(7.2);
      expect(r.value.trendDelta).toBe(-2); // 36 - 38
      expect(r.provenance.inputs).toContain("PULSE_WAVE_VELOCITY");
    }
  });

  it("ok but delta/band null without a profile age", async () => {
    findMany.mockResolvedValueOnce([{ value: 50 }]);
    findFirst.mockResolvedValueOnce(null);
    const r = await computeVascularAgeDelta("u1", NO_AGE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.deltaYears).toBeNull();
      expect(r.value.band).toBeNull();
      expect(r.value.trendDelta).toBeNull();
      expect(r.provenance.inputs).not.toContain("PULSE_WAVE_VELOCITY");
    }
  });
});
