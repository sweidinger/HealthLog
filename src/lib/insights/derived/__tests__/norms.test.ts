import { describe, it, expect } from "vitest";
import {
  lookupNormalRange,
  hasSharpenedNorm,
  predictSixMinuteWalkDistance,
} from "../norms";

describe("lookupNormalRange — the age/sex reference-range enabler", () => {
  it("returns a sex-specific VO2max band for a registered metric", () => {
    const male = lookupNormalRange("VO2_MAX", 35, "MALE");
    const female = lookupNormalRange("VO2_MAX", 35, "FEMALE");
    expect(male).not.toBeNull();
    expect(female).not.toBeNull();
    // male bands sit higher than female at the same decade
    expect(male!.low).toBeGreaterThan(female!.low);
    expect(male!.high).toBeGreaterThan(female!.high);
  });

  it("narrows resting-HR by age (sex-agnostic)", () => {
    const child = lookupNormalRange("RESTING_HEART_RATE", 4, null);
    const adult = lookupNormalRange("RESTING_HEART_RATE", 40, null);
    expect(child).not.toBeNull();
    expect(adult).not.toBeNull();
    // children run higher than adults
    expect(child!.high).toBeGreaterThan(adult!.high);
  });

  it("returns null when age is absent (falls back to flat anchor)", () => {
    expect(lookupNormalRange("VO2_MAX", null, "MALE")).toBeNull();
    expect(lookupNormalRange("VO2_MAX", undefined, "MALE")).toBeNull();
  });

  it("returns null for a metric with no norm table", () => {
    expect(lookupNormalRange("OXYGEN_SATURATION", 40, "MALE")).toBeNull();
    expect(lookupNormalRange("STEPS", 40, "FEMALE")).toBeNull();
  });

  it("returns null for a sex-specific-only table when profile sex is absent", () => {
    // VO2max is sex-specific only; without a sex we cannot pick one band.
    expect(lookupNormalRange("VO2_MAX", 35, null)).toBeNull();
  });

  it("prefers a sex-agnostic row when present and sex is absent", () => {
    // resting-HR rows are sex-agnostic, so an absent sex still resolves.
    expect(lookupNormalRange("RESTING_HEART_RATE", 40, null)).not.toBeNull();
  });

  it("clamps to the oldest bracket for very high ages", () => {
    const old = lookupNormalRange("VO2_MAX", 95, "FEMALE");
    expect(old).not.toBeNull();
  });

  it("rejects negative / non-finite ages", () => {
    expect(lookupNormalRange("RESTING_HEART_RATE", -5, null)).toBeNull();
    expect(lookupNormalRange("RESTING_HEART_RATE", Number.NaN, null)).toBeNull();
  });
});

describe("hasSharpenedNorm", () => {
  it("mirrors lookupNormalRange truthiness", () => {
    expect(hasSharpenedNorm("VO2_MAX", 35, "MALE")).toBe(true);
    expect(hasSharpenedNorm("VO2_MAX", 35, null)).toBe(false);
    expect(hasSharpenedNorm("STEPS", 35, "MALE")).toBe(false);
  });
});

describe("predictSixMinuteWalkDistance — Enright & Sherrill 1998", () => {
  it("matches the published male equation", () => {
    // 7.57·180 − 5.02·40 − 1.76·80 − 309 = 712 m
    expect(predictSixMinuteWalkDistance(40, 180, 80, "MALE")).toBeCloseTo(
      712,
      6,
    );
  });

  it("matches the published female equation", () => {
    // 2.11·165 − 2.29·65 − 5.78·40 + 667 = 635.1 m
    expect(predictSixMinuteWalkDistance(40, 165, 65, "FEMALE")).toBeCloseTo(
      635.1,
      6,
    );
  });

  it("returns null without a usable sex (the equations differ by sex)", () => {
    expect(predictSixMinuteWalkDistance(40, 180, 80, null)).toBeNull();
  });

  it("returns null when weight is absent (no silently-dropped term)", () => {
    expect(predictSixMinuteWalkDistance(40, 180, null, "MALE")).toBeNull();
  });

  it("returns null without height", () => {
    expect(predictSixMinuteWalkDistance(40, null, 80, "MALE")).toBeNull();
  });

  it("returns null for non-adult / non-finite ages", () => {
    expect(predictSixMinuteWalkDistance(12, 150, 45, "MALE")).toBeNull();
    expect(predictSixMinuteWalkDistance(Number.NaN, 180, 80, "MALE")).toBeNull();
    expect(predictSixMinuteWalkDistance(null, 180, 80, "MALE")).toBeNull();
  });
});
