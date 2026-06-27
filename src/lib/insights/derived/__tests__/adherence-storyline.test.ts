import { describe, it, expect } from "vitest";
import { shapeAdherenceStoryline } from "@/lib/insights/derived/adherence-storyline";

const base = {
  medLabel: "ramipril",
  medClass: "antihypertensive" as const,
  targetMetric: "BLOOD_PRESSURE_SYS" as const,
  adherencePct: 62,
  adherenceDays: 14,
  vitalPriorMean: 124,
  vitalRecentMean: 134,
  vitalDaysPrior: 8,
  vitalDaysRecent: 8,
  vitalSpread: 6,
};

describe("shapeAdherenceStoryline", () => {
  it("surfaces a storyline on an adherence dip + material vital move", () => {
    const out = shapeAdherenceStoryline(base);
    expect(out).not.toBeNull();
    expect(out!.vitalDirection).toBe("up");
    expect(out!.vitalDelta).toBe(10);
    expect(out!.confidenceTier).toBe("watch");
  });

  it("returns null when adherence is high (no dip)", () => {
    expect(shapeAdherenceStoryline({ ...base, adherencePct: 95 })).toBeNull();
  });

  it("returns null when adherence history is thin", () => {
    expect(shapeAdherenceStoryline({ ...base, adherenceDays: 4 })).toBeNull();
  });

  it("returns null when the vital move is not material", () => {
    expect(
      shapeAdherenceStoryline({
        ...base,
        vitalRecentMean: 125,
        vitalPriorMean: 124,
      }),
    ).toBeNull();
  });

  it("returns null when vital data is thin on a side", () => {
    expect(shapeAdherenceStoryline({ ...base, vitalDaysRecent: 2 })).toBeNull();
  });

  it("returns null when spread is zero (cannot judge materiality)", () => {
    expect(shapeAdherenceStoryline({ ...base, vitalSpread: 0 })).toBeNull();
  });
});
