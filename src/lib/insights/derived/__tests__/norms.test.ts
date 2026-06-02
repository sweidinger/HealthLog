import { describe, it, expect } from "vitest";
import { lookupNormalRange, hasSharpenedNorm } from "../norms";

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
