import { describe, it, expect } from "vitest";
import { computeHomaIr, classifyHomaIr } from "@/lib/labs/homa-ir";

describe("computeHomaIr", () => {
  it("computes the conventional-unit formula (glucose × insulin ÷ 405)", () => {
    // 90 mg/dL × 5 µIU/mL ÷ 405 = 1.111…
    expect(computeHomaIr(90, 5)).toBeCloseTo(1.1111, 3);
  });

  it("matches the SI form within rounding (mmol/L × insulin ÷ 22.5)", () => {
    // 100 mg/dL = 5.556 mmol/L; SI: 5.556 × 8 ÷ 22.5 ≈ 1.975; conv: 100×8÷405 ≈ 1.975
    const conv = computeHomaIr(100, 8)!;
    const si = (5.5556 * 8) / 22.5;
    expect(conv).toBeCloseTo(si, 2);
  });

  it("returns null for missing or non-positive inputs", () => {
    expect(computeHomaIr(null, 5)).toBeNull();
    expect(computeHomaIr(90, undefined)).toBeNull();
    expect(computeHomaIr(0, 5)).toBeNull();
    expect(computeHomaIr(90, -1)).toBeNull();
    expect(computeHomaIr(Number.NaN, 5)).toBeNull();
  });
});

describe("classifyHomaIr", () => {
  it("places values in the documented bands", () => {
    expect(classifyHomaIr(0.8)).toBe("optimal");
    expect(classifyHomaIr(1.5)).toBe("intermediate");
    expect(classifyHomaIr(2.5)).toBe("elevated");
    expect(classifyHomaIr(3.5)).toBe("high");
  });
});
