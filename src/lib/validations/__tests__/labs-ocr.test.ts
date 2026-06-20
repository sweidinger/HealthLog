import { describe, it, expect } from "vitest";

import {
  extractedLabsSchema,
  ocrCommitSchema,
  OCR_MAX_ROWS,
} from "../labs-ocr";

describe("extractedLabsSchema (untrusted provider output)", () => {
  it("parses a well-formed numeric + qualitative envelope", () => {
    const parsed = extractedLabsSchema.safeParse({
      reportDate: "2026-06-14",
      rows: [
        {
          analyte: "LDL-Cholesterin",
          value: 142,
          valueText: null,
          unit: "mg/dL",
          referenceLow: 0,
          referenceHigh: 116,
          takenAt: "2026-06-14",
          confidence: { analyte: 0.9, value: 0.8, unit: 0.9, range: 0.7 },
        },
        {
          analyte: "Borrelia IgG",
          value: null,
          valueText: "negativ",
          unit: null,
          referenceLow: null,
          referenceHigh: null,
          takenAt: null,
          confidence: { analyte: 0.95, value: 0.9, unit: 0, range: 0 },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rows).toHaveLength(2);
      expect(parsed.data.rows[1].valueText).toBe("negativ");
    }
  });

  it("tolerates a missing confidence block (defaults to 0 = flag for review)", () => {
    const parsed = extractedLabsSchema.safeParse({
      reportDate: null,
      rows: [
        {
          analyte: "Ferritin",
          value: null,
          valueText: null,
          unit: "ng/mL",
          referenceLow: null,
          referenceHigh: null,
          takenAt: null,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.rows[0].confidence).toEqual({
        analyte: 0,
        value: 0,
        unit: 0,
        range: 0,
      });
    }
  });

  it("coerces a garbage value to null rather than rejecting the row", () => {
    const parsed = extractedLabsSchema.safeParse({
      reportDate: null,
      rows: [
        {
          analyte: "TSH",
          value: "not a number",
          valueText: null,
          unit: "mIU/L",
          referenceLow: null,
          referenceHigh: null,
          takenAt: null,
          confidence: { analyte: 1, value: 0, unit: 1, range: 0 },
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rows[0].value).toBeNull();
  });

  it("rejects more than OCR_MAX_ROWS rows", () => {
    const rows = Array.from({ length: OCR_MAX_ROWS + 1 }, () => ({
      analyte: "X",
      value: 1,
      valueText: null,
      unit: "u",
      referenceLow: null,
      referenceHigh: null,
      takenAt: null,
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
    }));
    expect(
      extractedLabsSchema.safeParse({ reportDate: null, rows }).success,
    ).toBe(false);
  });
});

describe("ocrCommitSchema (confirmed rows)", () => {
  const base = {
    analyte: "LDL",
    takenAt: "2026-06-14T08:00:00.000Z",
  };

  it("accepts a numeric row with a unit", () => {
    const parsed = ocrCommitSchema.safeParse({
      rows: [{ ...base, value: 142, unit: "mg/dL", referenceHigh: 116 }],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a qualitative row without a unit", () => {
    const parsed = ocrCommitSchema.safeParse({
      rows: [
        {
          analyte: "Borrelia IgG",
          valueText: "negativ",
          takenAt: base.takenAt,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a numeric row missing a unit", () => {
    const parsed = ocrCommitSchema.safeParse({
      rows: [{ ...base, value: 142 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a row with both value and valueText", () => {
    const parsed = ocrCommitSchema.safeParse({
      rows: [{ ...base, value: 1, valueText: "x", unit: "u" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a row with neither value nor valueText", () => {
    const parsed = ocrCommitSchema.safeParse({
      rows: [{ ...base, unit: "u" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a transposed reference range", () => {
    const parsed = ocrCommitSchema.safeParse({
      rows: [
        { ...base, value: 1, unit: "u", referenceLow: 10, referenceHigh: 1 },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty rows array", () => {
    expect(ocrCommitSchema.safeParse({ rows: [] }).success).toBe(false);
  });
});
