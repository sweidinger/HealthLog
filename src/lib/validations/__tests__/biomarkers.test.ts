import { describe, expect, it } from "vitest";

import { createBiomarkerSchema, updateBiomarkerSchema } from "../biomarkers";

describe("createBiomarkerSchema", () => {
  it("accepts a minimal marker (name + unit only)", () => {
    const r = createBiomarkerSchema.safeParse({ name: "LDL", unit: "mg/dL" });
    expect(r.success).toBe(true);
  });

  it("accepts both bounds when low <= high", () => {
    const r = createBiomarkerSchema.safeParse({
      name: "Fasting glucose",
      unit: "mg/dL",
      lowerBound: 70,
      upperBound: 100,
    });
    expect(r.success).toBe(true);
  });

  it("accepts an open-ended upper bound (lower omitted)", () => {
    const r = createBiomarkerSchema.safeParse({
      name: "LDL",
      unit: "mg/dL",
      upperBound: 116,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a transposed range (low > high)", () => {
    const r = createBiomarkerSchema.safeParse({
      name: "LDL",
      unit: "mg/dL",
      lowerBound: 200,
      upperBound: 100,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const r = createBiomarkerSchema.safeParse({ name: "  ", unit: "mg/dL" });
    expect(r.success).toBe(false);
  });

  it("normalises an empty context to undefined", () => {
    const r = createBiomarkerSchema.safeParse({
      name: "TSH",
      unit: "mIU/L",
      context: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.context).toBeUndefined();
  });
});

describe("updateBiomarkerSchema", () => {
  it("accepts a partial edit", () => {
    const r = updateBiomarkerSchema.safeParse({ unit: "mmol/L" });
    expect(r.success).toBe(true);
  });

  it("accepts an explicit null to clear a bound", () => {
    const r = updateBiomarkerSchema.safeParse({ lowerBound: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lowerBound).toBeNull();
  });

  it("still rejects a transposed range on update", () => {
    const r = updateBiomarkerSchema.safeParse({
      lowerBound: 10,
      upperBound: 5,
    });
    expect(r.success).toBe(false);
  });
});
