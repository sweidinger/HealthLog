import { describe, it, expect } from "vitest";

import {
  classifyReferenceRange,
  createLabResultSchema,
  listLabResultsSchema,
  updateLabResultSchema,
} from "../labs";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe("createLabResultSchema", () => {
  it("accepts a minimal valid reading", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "HbA1c",
      value: 5.4,
      unit: "%",
      takenAt: RECENT,
    });
    expect(r.success).toBe(true);
  });

  it("normalises a backdatable takenAt to a Date", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "LDL",
      value: 110,
      unit: "mg/dL",
      takenAt: RECENT,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.takenAt).toBeInstanceOf(Date);
  });

  it("rejects a future takenAt", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "LDL",
      value: 110,
      unit: "mg/dL",
      takenAt: FUTURE,
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty analyte", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "   ",
      value: 1,
      unit: "%",
      takenAt: RECENT,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a transposed reference range (low > high)", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "Ferritin",
      value: 50,
      unit: "ng/mL",
      referenceLow: 300,
      referenceHigh: 30,
      takenAt: RECENT,
    });
    expect(r.success).toBe(false);
  });

  it("accepts a single (upper-only) reference bound", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "LDL",
      value: 110,
      unit: "mg/dL",
      referenceHigh: 116,
      takenAt: RECENT,
    });
    expect(r.success).toBe(true);
  });

  it("normalises an empty-string panel to undefined", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "TSH",
      value: 2,
      unit: "mIU/L",
      panel: "",
      takenAt: RECENT,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.panel).toBeUndefined();
  });

  it("rejects a non-finite value", () => {
    const r = createLabResultSchema.safeParse({
      analyte: "LDL",
      value: Number.POSITIVE_INFINITY,
      unit: "mg/dL",
      takenAt: RECENT,
    });
    expect(r.success).toBe(false);
  });
});

describe("updateLabResultSchema", () => {
  it("accepts an explicit null to clear panel + note", () => {
    const r = updateLabResultSchema.safeParse({ panel: null, note: null });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.panel).toBeNull();
      expect(r.data.note).toBeNull();
    }
  });

  it("accepts a partial value-only edit", () => {
    const r = updateLabResultSchema.safeParse({ value: 5.6 });
    expect(r.success).toBe(true);
  });

  it("still enforces the range order when both bounds are supplied", () => {
    const r = updateLabResultSchema.safeParse({
      referenceLow: 10,
      referenceHigh: 1,
    });
    expect(r.success).toBe(false);
  });
});

describe("listLabResultsSchema", () => {
  it("defaults limit/offset/sortDir", () => {
    const r = listLabResultsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(100);
      expect(r.data.offset).toBe(0);
      expect(r.data.sortDir).toBe("desc");
    }
  });

  it("caps limit at 500", () => {
    const r = listLabResultsSchema.safeParse({ limit: "9999" });
    expect(r.success).toBe(false);
  });
});

describe("classifyReferenceRange", () => {
  it("returns unknown when no bounds are given", () => {
    expect(classifyReferenceRange(5, null, null)).toBe("unknown");
    expect(classifyReferenceRange(5, undefined, undefined)).toBe("unknown");
  });

  it("returns in-range inside both bounds", () => {
    expect(classifyReferenceRange(5, 4, 6)).toBe("in-range");
  });

  it("treats the bounds as inclusive", () => {
    expect(classifyReferenceRange(4, 4, 6)).toBe("in-range");
    expect(classifyReferenceRange(6, 4, 6)).toBe("in-range");
  });

  it("returns below when under the low bound", () => {
    expect(classifyReferenceRange(3.9, 4, 6)).toBe("below");
  });

  it("returns above when over the high bound", () => {
    expect(classifyReferenceRange(6.1, 4, 6)).toBe("above");
  });

  it("classifies against a single upper bound", () => {
    expect(classifyReferenceRange(120, null, 116)).toBe("above");
    expect(classifyReferenceRange(100, null, 116)).toBe("in-range");
  });

  it("classifies against a single lower bound", () => {
    expect(classifyReferenceRange(8, 10, null)).toBe("below");
    expect(classifyReferenceRange(12, 10, null)).toBe("in-range");
  });
});
