/**
 * The drug-profile registry is the switch that decides whether a medication
 * gets the tailored surfaces (daily check-in, target-symptom tracking). It must
 * resolve a known class to its profile, return null for anything without one,
 * and treat null/undefined/empty class the same as "no profile" — so a plain
 * medication is never handed a profile it wasn't authored for.
 */
import { describe, expect, it } from "vitest";

import { hasDrugProfile, profileForTreatmentClass } from "../registry";
import { STIMULANT_ADHD_PROFILE } from "../stimulant-adhd";

describe("drug-profile registry", () => {
  it("resolves STIMULANT to the ADHD stimulant profile", () => {
    expect(profileForTreatmentClass("STIMULANT")).toBe(STIMULANT_ADHD_PROFILE);
    expect(hasDrugProfile("STIMULANT")).toBe(true);
  });

  it("returns null for a class without a profile", () => {
    expect(profileForTreatmentClass("GENERIC")).toBeNull();
    expect(hasDrugProfile("GENERIC")).toBe(false);
  });

  it("treats null/undefined/empty class as no profile", () => {
    for (const value of [null, undefined, ""] as const) {
      expect(profileForTreatmentClass(value)).toBeNull();
      expect(hasDrugProfile(value)).toBe(false);
    }
  });

  it("a resolved profile applies to the class it was looked up by", () => {
    const profile = profileForTreatmentClass("STIMULANT");
    expect(profile?.treatmentClass).toBe("STIMULANT");
  });
});
