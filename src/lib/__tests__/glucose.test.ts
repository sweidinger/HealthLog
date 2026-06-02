import { describe, it, expect } from "vitest";
import {
  mgdlToMmol,
  mmolToMgdl,
  convertGlucose,
  toCanonicalMgdl,
  resolveGlucoseUnit,
  thresholdMetricForContext,
} from "../glucose";

describe("glucose conversion", () => {
  it("converts mg/dL to mmol/L with 1 decimal", () => {
    expect(mgdlToMmol(100)).toBe(5.5);
    expect(mgdlToMmol(126)).toBeCloseTo(7.0, 1); // diabetes threshold
    expect(mgdlToMmol(70)).toBeCloseTo(3.9, 1); // hypoglycemia threshold
  });

  it("convertGlucose dispatches to the right unit", () => {
    expect(convertGlucose(100, "mg/dL")).toBe(100);
    expect(convertGlucose(100, "mmol/L")).toBe(5.5);
  });

  it("resolveGlucoseUnit defaults to mg/dL", () => {
    expect(resolveGlucoseUnit(null)).toBe("mg/dL");
    expect(resolveGlucoseUnit(undefined)).toBe("mg/dL");
    expect(resolveGlucoseUnit("mmol/L")).toBe("mmol/L");
    expect(resolveGlucoseUnit("mg/dL")).toBe("mg/dL");
    expect(resolveGlucoseUnit("random-garbage")).toBe("mg/dL");
  });

  it("thresholdMetricForContext maps every context", () => {
    expect(thresholdMetricForContext("FASTING")).toBe("BLOOD_GLUCOSE_FASTING");
    expect(thresholdMetricForContext("POSTPRANDIAL")).toBe(
      "BLOOD_GLUCOSE_POSTPRANDIAL",
    );
    expect(thresholdMetricForContext("RANDOM")).toBe("BLOOD_GLUCOSE_RANDOM");
    expect(thresholdMetricForContext("BEDTIME")).toBe("BLOOD_GLUCOSE_BEDTIME");
  });

  // Display-unit logic guard for the targets/dashboard surfaces:
  // canonical mg/dL stays integer; mmol/L stays 1-decimal; ranges convert too.
  it("display unit conversion preserves integer/decimal precision", () => {
    const fastingMin = 70; // mg/dL
    const fastingMax = 99;
    const ada126 = 126; // diabetes threshold

    expect(convertGlucose(fastingMin, "mg/dL")).toBe(70);
    expect(convertGlucose(fastingMax, "mg/dL")).toBe(99);
    expect(convertGlucose(ada126, "mg/dL")).toBe(126);

    expect(convertGlucose(fastingMin, "mmol/L")).toBe(3.9);
    expect(convertGlucose(fastingMax, "mmol/L")).toBe(5.5);
    expect(convertGlucose(ada126, "mmol/L")).toBe(7);
  });

  // The target-editor write path: a value the user typed in their
  // display unit must persist as canonical mg/dL. Before the fix the
  // editor saved the mmol/L number verbatim (a 5.5 mmol/L target stored
  // as 5.5 mg/dL, or rejected outright by the 40–400 mg/dL bounds).
  it("converts a display-unit value back to canonical mg/dL", () => {
    expect(mmolToMgdl(5.5)).toBe(99);
    expect(mmolToMgdl(7.0)).toBe(126); // ADA diabetes threshold
    expect(mmolToMgdl(3.9)).toBe(70); // hypoglycemia threshold
  });

  it("toCanonicalMgdl is the inverse of convertGlucose at the editor boundary", () => {
    // mg/dL display unit is already canonical — only rounds.
    expect(toCanonicalMgdl(126, "mg/dL")).toBe(126);
    expect(toCanonicalMgdl(99.4, "mg/dL")).toBe(99);
    // mmol/L display unit converts back; the round-trip is stable to the
    // 1-decimal mmol/L the UI shows (≤1 mg/dL drift is unavoidable).
    expect(toCanonicalMgdl(7.0, "mmol/L")).toBe(126);
    expect(toCanonicalMgdl(mgdlToMmol(126), "mmol/L")).toBeCloseTo(126, -0.5);
    expect(toCanonicalMgdl(mgdlToMmol(70), "mmol/L")).toBe(70);
  });
});
