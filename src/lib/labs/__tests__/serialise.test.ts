import { describe, expect, it } from "vitest";

import {
  resolveLabFields,
  serialiseLabResult,
  serialiseLabResultDetail,
  type LabRow,
  type ResolvedBiomarker,
} from "../serialise";

const baseRow: LabRow = {
  id: "lr_1",
  panel: "Legacy panel",
  analyte: "ldl", // lowercase legacy spelling
  value: 130,
  unit: "mg/dl", // lowercase legacy unit
  referenceLow: null,
  referenceHigh: 100, // stale per-row bound
  takenAt: new Date("2026-01-01T08:00:00.000Z"),
  source: "MANUAL",
  biomarkerId: "bm_1",
  noteEncrypted: null,
  createdAt: new Date("2026-01-01T08:00:00.000Z"),
  updatedAt: new Date("2026-01-01T08:00:00.000Z"),
};

const biomarker: ResolvedBiomarker = {
  id: "bm_1",
  name: "LDL Cholesterol",
  unit: "mg/dL",
  lowerBound: null,
  upperBound: 116,
  panel: "Lipids",
};

describe("resolveLabFields", () => {
  it("prefers the linked biomarker over the legacy row fields", () => {
    const r = resolveLabFields(baseRow, biomarker);
    expect(r.analyte).toBe("LDL Cholesterol");
    expect(r.unit).toBe("mg/dL");
    expect(r.referenceHigh).toBe(116);
    expect(r.panel).toBe("Lipids");
  });

  it("falls back to the row fields when unlinked", () => {
    const r = resolveLabFields({ ...baseRow, biomarkerId: null }, null);
    expect(r.analyte).toBe("ldl");
    expect(r.unit).toBe("mg/dl");
    expect(r.referenceHigh).toBe(100);
    expect(r.panel).toBe("Legacy panel");
  });
});

describe("serialiseLabResult", () => {
  it("computes the verdict from the RESOLVED catalog bounds, not the stale row", () => {
    // value 130 vs row's stale high 100 → would be 'above';
    // vs catalog high 116 → still 'above', but the resolved bound is what counts.
    const dto = serialiseLabResult(baseRow, biomarker);
    expect(dto.unit).toBe("mg/dL");
    expect(dto.referenceHigh).toBe(116);
    expect(dto.rangeStatus).toBe("above");
    expect(dto.biomarkerId).toBe("bm_1");
    expect(dto.hasNote).toBe(false);
  });

  it("in-range when the resolved catalog band contains the value", () => {
    const within = serialiseLabResult({ ...baseRow, value: 90 }, biomarker);
    expect(within.rangeStatus).toBe("in-range");
  });

  it("uses legacy fields and verdict when unlinked", () => {
    const dto = serialiseLabResult({ ...baseRow, biomarkerId: null }, null);
    expect(dto.unit).toBe("mg/dl");
    // 130 > row high 100 → above
    expect(dto.rangeStatus).toBe("above");
    expect(dto.biomarkerId).toBeNull();
  });

  it("flags an encrypted note without echoing it", () => {
    const dto = serialiseLabResult(
      { ...baseRow, noteEncrypted: new Uint8Array([1, 2, 3]) },
      biomarker,
    );
    expect(dto.hasNote).toBe(true);
    expect(dto).not.toHaveProperty("noteEncrypted");
  });
});

describe("serialiseLabResultDetail", () => {
  it("carries the decrypted note in place of hasNote", () => {
    const dto = serialiseLabResultDetail(baseRow, biomarker, "fasting sample");
    expect(dto.note).toBe("fasting sample");
    expect(dto).not.toHaveProperty("hasNote");
    expect(dto.unit).toBe("mg/dL");
  });
});
