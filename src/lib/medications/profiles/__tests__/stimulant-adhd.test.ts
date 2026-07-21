/**
 * The stimulant/ADHD drug profile must stay consistent with the side-effect
 * taxonomy: every side-effect it references has to be a real entry that is
 * actually VISIBLE for the STIMULANT class (its category is in the class's
 * scoped set). Otherwise the profile would promise a daily-check-in item the
 * picker can never show. Also pins the target-symptom shape.
 */
import { describe, expect, it } from "vitest";

import { STIMULANT_ADHD_PROFILE } from "../stimulant-adhd";
import {
  categoriesForTreatmentClass,
  categoryForEntry,
} from "@/lib/medications/side-effects/taxonomy";

describe("STIMULANT_ADHD_PROFILE", () => {
  const stimulantCategories = new Set(
    categoriesForTreatmentClass(STIMULANT_ADHD_PROFILE.treatmentClass),
  );

  it("targets the STIMULANT treatment class, which has a logbook", () => {
    expect(STIMULANT_ADHD_PROFILE.treatmentClass).toBe("STIMULANT");
    expect(stimulantCategories.size).toBeGreaterThan(0);
  });

  it("every side-effect entry is visible for the stimulant class", () => {
    for (const se of STIMULANT_ADHD_PROFILE.sideEffects) {
      expect(stimulantCategories.has(categoryForEntry(se.entry))).toBe(true);
    }
  });

  it("has no duplicate side-effect entries", () => {
    const entries = STIMULANT_ADHD_PROFILE.sideEffects.map((s) => s.entry);
    expect(new Set(entries).size).toBe(entries.length);
  });

  it("defines target symptoms with unique keys, labels, and a sane scale", () => {
    const keys = STIMULANT_ADHD_PROFILE.targetSymptoms.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    for (const s of STIMULANT_ADHD_PROFILE.targetSymptoms) {
      expect(s.labelDe.length).toBeGreaterThan(0);
      expect(s.labelEn.length).toBeGreaterThan(0);
    }
    expect(STIMULANT_ADHD_PROFILE.targetSymptomScale.min).toBeLessThan(
      STIMULANT_ADHD_PROFILE.targetSymptomScale.max,
    );
  });
});
