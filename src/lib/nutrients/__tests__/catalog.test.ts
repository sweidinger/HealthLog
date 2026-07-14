/**
 * v1.28 — nutrient-catalog invariants.
 *
 * The catalog is the closed source of truth for the intake sync: codes,
 * HK identifiers, canonical units (the µg/mg guard), plausibility caps,
 * and the EFSA references a later Coach block reads. These tests pin
 * the invariants the routes and the wire contract rely on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NUTRIENT_CATALOG,
  NUTRIENT_CODES,
  NUTRIENT_DEFINITIONS,
  isNutrientCode,
} from "../catalog";

describe("nutrient catalog", () => {
  it("carries exactly the 26 maintainer-scoped codes (no sodium, no potassium, no macros)", () => {
    expect(NUTRIENT_CODES).toHaveLength(26);
    expect(Object.keys(NUTRIENT_CATALOG).sort()).toEqual(
      [...NUTRIENT_CODES].sort(),
    );
    // The maintainer exclusions stay excluded.
    for (const banned of [
      "sodium",
      "potassium",
      "energy",
      "carbohydrates",
      "protein",
      "fat",
      "sugar",
      "fiber",
    ]) {
      expect(isNutrientCode(banned), `banned code present: ${banned}`).toBe(
        false,
      );
    }
  });

  it("codes and HealthKit identifiers are unique, and every HK id is a Dietary quantity type", () => {
    const codes = new Set<string>();
    const hkIds = new Set<string>();
    for (const def of NUTRIENT_DEFINITIONS) {
      expect(codes.has(def.code)).toBe(false);
      expect(hkIds.has(def.hkIdentifier)).toBe(false);
      codes.add(def.code);
      hkIds.add(def.hkIdentifier);
      expect(def.hkIdentifier).toMatch(
        /^HKQuantityTypeIdentifierDietary[A-Za-z0-9]+$/,
      );
    }
  });

  it("every unit is canonical (mg | ug | ml) and water is the only ml type", () => {
    for (const def of NUTRIENT_DEFINITIONS) {
      expect(["mg", "ug", "ml"]).toContain(def.unit);
    }
    const mlCodes = NUTRIENT_DEFINITIONS.filter((d) => d.unit === "ml").map(
      (d) => d.code,
    );
    expect(mlCodes).toEqual(["water"]);
    // The known-µg micros stay µg — a silent switch to mg here would be
    // the exact 1000× hazard the unit echo guards against.
    for (const ugCode of [
      "vitamin_a",
      "biotin",
      "folate",
      "vitamin_b12",
      "vitamin_d",
      "vitamin_k",
      "selenium",
      "chromium",
      "molybdenum",
      "iodine",
    ] as const) {
      expect(NUTRIENT_CATALOG[ugCode].unit).toBe("ug");
    }
    expect(NUTRIENT_CATALOG.caffeine.unit).toBe("mg");
  });

  it("every code carries a finite positive plausibility cap", () => {
    for (const def of NUTRIENT_DEFINITIONS) {
      expect(Number.isFinite(def.plausibleDailyMax)).toBe(true);
      expect(def.plausibleDailyMax).toBeGreaterThan(0);
    }
    // The design-pinned guards.
    expect(NUTRIENT_CATALOG.caffeine.plausibleDailyMax).toBe(2000);
    expect(NUTRIENT_CATALOG.water.plausibleDailyMax).toBe(20000);
  });

  it("every code has a reference entry carrying kind, direction, a citation, and a resolvable value", () => {
    for (const def of NUTRIENT_DEFINITIONS) {
      const ref = def.reference;
      expect(ref, `missing reference: ${def.code}`).toBeDefined();
      expect(["PRI", "AI", "safeLevel"]).toContain(ref.kind);
      expect(["target", "upperGuidance"]).toContain(ref.direction);
      expect(ref.source.length).toBeGreaterThan(0);
      // Value shape: a uniform adult value XOR a full sex split — never
      // both, never a half split (profile resolution depends on this).
      const hasAdult = ref.adult != null;
      const hasMale = ref.male != null;
      const hasFemale = ref.female != null;
      expect(hasMale, `half sex-split: ${def.code}`).toBe(hasFemale);
      expect(hasAdult !== hasMale, `value shape: ${def.code}`).toBe(true);
      for (const v of [ref.adult, ref.male, ref.female]) {
        if (v != null) expect(v).toBeGreaterThan(0);
      }
    }
  });

  it("caffeine is the one upperGuidance reference; everything else is a target", () => {
    for (const def of NUTRIENT_DEFINITIONS) {
      expect(def.reference.direction).toBe(
        def.code === "caffeine" ? "upperGuidance" : "target",
      );
    }
    expect(NUTRIENT_CATALOG.caffeine.reference.kind).toBe("safeLevel");
    expect(NUTRIENT_CATALOG.caffeine.reference.adult).toBe(400);
  });

  it("every citation names EFSA, except the documented chromium exception (EFSA sets no DRV)", () => {
    for (const def of NUTRIENT_DEFINITIONS) {
      if (def.code === "chromium") {
        expect(def.reference.source).toContain("NIH");
        expect(def.reference.source).toContain("EFSA");
        continue;
      }
      expect(def.reference.source, `citation: ${def.code}`).toContain("EFSA");
    }
  });

  it("iron carries the EFSA sex split (11 male / 16 female)", () => {
    expect(NUTRIENT_CATALOG.iron.reference.male).toBe(11);
    expect(NUTRIENT_CATALOG.iron.reference.female).toBe(16);
  });

  it("every labelKey follows nutrients.names.<code> and resolves in the EN bundle", () => {
    const en = JSON.parse(
      readFileSync(join(__dirname, "../../../../messages/en.json"), "utf8"),
    ) as { nutrients?: { names?: Record<string, string> } };
    for (const def of NUTRIENT_DEFINITIONS) {
      expect(def.labelKey).toBe(`nutrients.names.${def.code}`);
      expect(
        en.nutrients?.names?.[def.code],
        `EN name missing: ${def.code}`,
      ).toBeTruthy();
    }
  });
});
