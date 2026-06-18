/**
 * v1.18.6 — diabetes-aware glucose target resolver.
 *
 * Pins: flag OFF → general non-diabetic band; flag ON → tighter ADA goal band;
 * a user override always wins over BOTH; the flag is consumed verbatim (never
 * derived from a value).
 */
import { describe, expect, it } from "vitest";
import {
  resolveGlucoseTarget,
  DIABETIC_GOAL_BANDS,
} from "../glucose-targets";
import type { UserProfileForRange } from "@/lib/analytics/effective-range";

const profile: UserProfileForRange = {
  heightCm: 178,
  dateOfBirth: "1985-01-01",
  gender: "MALE",
};

describe("resolveGlucoseTarget", () => {
  it("uses the general non-diabetic band when the flag is OFF", () => {
    const r = resolveGlucoseTarget({
      context: "FASTING",
      hasDiabetes: false,
      profile,
      overrides: null,
    });
    expect(r.source).toBe("default");
    expect(r.isOverride).toBe(false);
    // General fasting normal band is 70–99 (non-diabetic).
    expect(r.range?.greenMin).toBe(70);
    expect(r.range?.greenMax).toBe(99);
  });

  it("uses the tighter ADA goal band when the flag is ON (fasting 80-130)", () => {
    const r = resolveGlucoseTarget({
      context: "FASTING",
      hasDiabetes: true,
      profile,
      overrides: null,
    });
    expect(r.source).toBe("ADA goal (diabetes)");
    expect(r.range?.greenMin).toBe(DIABETIC_GOAL_BANDS.FASTING.min);
    expect(r.range?.greenMax).toBe(DIABETIC_GOAL_BANDS.FASTING.max);
    expect(r.range?.greenMin).toBe(80);
    expect(r.range?.greenMax).toBe(130);
  });

  it("uses the ADA postprandial goal band (< 180) when the flag is ON", () => {
    const r = resolveGlucoseTarget({
      context: "POSTPRANDIAL",
      hasDiabetes: true,
      profile,
      overrides: null,
    });
    expect(r.range?.greenMin).toBe(80);
    expect(r.range?.greenMax).toBe(180);
  });

  it("lets a user override win over the diabetic goal band", () => {
    const r = resolveGlucoseTarget({
      context: "FASTING",
      hasDiabetes: true,
      profile,
      overrides: { BLOOD_GLUCOSE_FASTING: { min: 90, max: 120 } },
    });
    expect(r.source).toBe("custom");
    expect(r.isOverride).toBe(true);
    expect(r.range?.greenMin).toBe(90);
    expect(r.range?.greenMax).toBe(120);
  });

  it("lets a user override win over the general band (flag OFF)", () => {
    const r = resolveGlucoseTarget({
      context: "FASTING",
      hasDiabetes: false,
      profile,
      overrides: { BLOOD_GLUCOSE_FASTING: { min: 75, max: 105 } },
    });
    expect(r.source).toBe("custom");
    expect(r.range?.greenMin).toBe(75);
    expect(r.range?.greenMax).toBe(105);
  });

  it("resolves the diabetic goal band identically for every context", () => {
    for (const ctx of ["FASTING", "POSTPRANDIAL", "RANDOM", "BEDTIME"] as const) {
      const r = resolveGlucoseTarget({
        context: ctx,
        hasDiabetes: true,
        profile,
        overrides: null,
      });
      expect(r.range?.greenMin).toBe(DIABETIC_GOAL_BANDS[ctx].min);
      expect(r.range?.greenMax).toBe(DIABETIC_GOAL_BANDS[ctx].max);
    }
  });
});
