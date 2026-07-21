/**
 * v1.4.25 W19d — taxonomy pure-module tests.
 *
 * The taxonomy is a contract the API validator, the picker UI, and
 * the Coach snapshot all depend on. These tests pin the shape:
 *   - every entry maps to exactly one category
 *   - exactly 21 entries across 5 categories
 *   - every category has at least one entry
 *   - severity labels are deterministic and ordered
 */

import { describe, expect, it } from "vitest";

import {
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
} from "@/generated/prisma/client";
import {
  SIDE_EFFECT_CATEGORIES,
  SIDE_EFFECT_CATEGORY_ORDER,
  SIDE_EFFECT_ENTRIES_BY_CATEGORY,
  SIDE_EFFECT_ENTRY_COUNT,
  SIDE_EFFECT_SEVERITY_LADDER,
  categoriesForTreatmentClass,
  categoryForEntry,
  entriesByCategory,
  hasSideEffectLogbook,
  isSideEffectSeverity,
  severityLikertLabel,
} from "../taxonomy";

const ALL_ENTRIES: MedicationSideEffectEntry[] = [
  "NAUSEA",
  "VOMITING",
  "DIARRHEA",
  "CONSTIPATION",
  "ABDOMINAL_PAIN",
  "HYPOGLYCEMIA_SYMPTOMS",
  "DEHYDRATION",
  "ANOREXIA",
  "ELECTROLYTE_FATIGUE",
  "INJECTION_REDNESS",
  "INJECTION_SWELLING",
  "INJECTION_BRUISING",
  "INJECTION_INDURATION",
  "BRAIN_FOG",
  "DIZZINESS",
  "LOW_MOOD",
  "LOW_ENERGY",
  "EARLY_SATIETY",
  "GASTROPARESIS_LIKE",
  "DYSGEUSIA",
  "GALLBLADDER_DISCOMFORT",
  "INSOMNIA",
  "PALPITATIONS",
  "RESTLESSNESS",
  "TREMOR",
  "TICS",
  "SWEATING",
  "REDUCED_APPETITE",
  "DRY_MOUTH",
  "BRUXISM",
  "HEADACHE",
  "IRRITABILITY",
  "EMOTIONAL_BLUNTING",
  "AFTERNOON_REBOUND",
  "ANXIETY",
  "MOOD_SWINGS",
  "FATIGUE",
];

const ALL_CATEGORIES: MedicationSideEffectCategory[] = [
  "GI",
  "METABOLIC",
  "INJECTION_SITE",
  "COGNITIVE",
  "GLP1_SPECIFIC",
  "STIMULANT_ACTIVATION",
  "STIMULANT_SOMATIC",
  "STIMULANT_MOOD",
];

describe("SIDE_EFFECT_CATEGORIES — entry → category mapping", () => {
  it("declares exactly 37 entries", () => {
    expect(Object.keys(SIDE_EFFECT_CATEGORIES)).toHaveLength(37);
    expect(SIDE_EFFECT_ENTRY_COUNT).toBe(37);
  });

  it("maps every entry to a known category", () => {
    for (const entry of ALL_ENTRIES) {
      const cat = SIDE_EFFECT_CATEGORIES[entry];
      expect(ALL_CATEGORIES).toContain(cat);
    }
  });

  it("categoryForEntry returns the same mapping as the table", () => {
    for (const entry of ALL_ENTRIES) {
      expect(categoryForEntry(entry)).toBe(SIDE_EFFECT_CATEGORIES[entry]);
    }
  });
});

describe("SIDE_EFFECT_ENTRIES_BY_CATEGORY — category → entries reverse index", () => {
  it("covers all five categories", () => {
    expect(Object.keys(SIDE_EFFECT_ENTRIES_BY_CATEGORY).sort()).toEqual(
      [...ALL_CATEGORIES].sort(),
    );
  });

  it("every category has at least one entry", () => {
    for (const category of ALL_CATEGORIES) {
      expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY[category].length).toBeGreaterThan(
        0,
      );
    }
  });

  it("matches the per-category counts (GLP-1: GI 5, METABOLIC 4, INJECTION_SITE 4, COGNITIVE 4, GLP1_SPECIFIC 4; stimulant: ACTIVATION 6, SOMATIC 4, MOOD 6)", () => {
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.GI).toHaveLength(5);
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.METABOLIC).toHaveLength(4);
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.INJECTION_SITE).toHaveLength(4);
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.COGNITIVE).toHaveLength(4);
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.GLP1_SPECIFIC).toHaveLength(4);
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.STIMULANT_ACTIVATION).toHaveLength(
      6,
    );
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.STIMULANT_SOMATIC).toHaveLength(4);
    expect(SIDE_EFFECT_ENTRIES_BY_CATEGORY.STIMULANT_MOOD).toHaveLength(6);
  });

  it("reverse index is consistent with the forward mapping", () => {
    for (const category of ALL_CATEGORIES) {
      for (const entry of SIDE_EFFECT_ENTRIES_BY_CATEGORY[category]) {
        expect(SIDE_EFFECT_CATEGORIES[entry]).toBe(category);
      }
    }
  });

  it("every entry appears in exactly one category bucket", () => {
    const seen = new Set<MedicationSideEffectEntry>();
    for (const category of ALL_CATEGORIES) {
      for (const entry of SIDE_EFFECT_ENTRIES_BY_CATEGORY[category]) {
        expect(seen.has(entry)).toBe(false);
        seen.add(entry);
      }
    }
    expect(seen.size).toBe(37);
  });

  it("entriesByCategory helper is a thin wrapper", () => {
    for (const category of ALL_CATEGORIES) {
      expect(entriesByCategory(category)).toEqual(
        SIDE_EFFECT_ENTRIES_BY_CATEGORY[category],
      );
    }
  });
});

describe("SIDE_EFFECT_CATEGORY_ORDER — UI category sequence", () => {
  it("contains every category exactly once", () => {
    expect([...SIDE_EFFECT_CATEGORY_ORDER].sort()).toEqual(
      [...ALL_CATEGORIES].sort(),
    );
  });

  it("leads with GI — the EMA most-common cluster during titration", () => {
    expect(SIDE_EFFECT_CATEGORY_ORDER[0]).toBe("GI");
  });
});

describe("severityLikertLabel — 1-5 Likert → semantic label", () => {
  it("returns mild / moderate / significant / severe / verySevere", () => {
    expect(severityLikertLabel(1)).toBe("mild");
    expect(severityLikertLabel(2)).toBe("moderate");
    expect(severityLikertLabel(3)).toBe("significant");
    expect(severityLikertLabel(4)).toBe("severe");
    expect(severityLikertLabel(5)).toBe("verySevere");
  });

  it("is deterministic — same input twice yields the same output", () => {
    expect(severityLikertLabel(3)).toBe(severityLikertLabel(3));
  });

  it("ladder is monotonic — index matches severity - 1", () => {
    for (let s = 1; s <= 5; s++) {
      expect(SIDE_EFFECT_SEVERITY_LADDER[s - 1]).toBe(
        severityLikertLabel(s as 1 | 2 | 3 | 4 | 5),
      );
    }
  });

  it("ladder length is 5", () => {
    expect(SIDE_EFFECT_SEVERITY_LADDER).toHaveLength(5);
  });
});

describe("isSideEffectSeverity — type guard", () => {
  it("accepts 1 through 5", () => {
    expect(isSideEffectSeverity(1)).toBe(true);
    expect(isSideEffectSeverity(5)).toBe(true);
  });

  it("rejects 0 and 6", () => {
    expect(isSideEffectSeverity(0)).toBe(false);
    expect(isSideEffectSeverity(6)).toBe(false);
  });

  it("rejects non-integer", () => {
    expect(isSideEffectSeverity(2.5)).toBe(false);
  });
});

describe("categoriesForTreatmentClass — class-scoped picker visibility", () => {
  it("GLP1 sees the five GLP-1 categories in the historical order", () => {
    expect(categoriesForTreatmentClass("GLP1")).toEqual([
      "GI",
      "METABOLIC",
      "INJECTION_SITE",
      "COGNITIVE",
      "GLP1_SPECIFIC",
    ]);
  });

  it("STIMULANT sees only the three stimulant categories", () => {
    expect(categoriesForTreatmentClass("STIMULANT")).toEqual([
      "STIMULANT_ACTIVATION",
      "STIMULANT_SOMATIC",
      "STIMULANT_MOOD",
    ]);
  });

  it("the GLP-1 and stimulant category sets never overlap", () => {
    const glp1 = new Set(categoriesForTreatmentClass("GLP1"));
    for (const c of categoriesForTreatmentClass("STIMULANT")) {
      expect(glp1.has(c)).toBe(false);
    }
  });

  it("GENERIC / unknown / nullish classes have no logbook", () => {
    expect(categoriesForTreatmentClass("GENERIC")).toEqual([]);
    expect(categoriesForTreatmentClass(undefined)).toEqual([]);
    expect(categoriesForTreatmentClass(null)).toEqual([]);
    expect(hasSideEffectLogbook("GENERIC")).toBe(false);
    expect(hasSideEffectLogbook("GLP1")).toBe(true);
    expect(hasSideEffectLogbook("STIMULANT")).toBe(true);
  });
});
