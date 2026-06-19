import { describe, expect, it } from "vitest";

import { groupRowsByAnalyte } from "../lab-biomarker-backfill";

function row(
  id: string,
  analyte: string,
  unit: string,
  takenAt: string,
  opts: {
    low?: number | null;
    high?: number | null;
    panel?: string | null;
  } = {},
) {
  return {
    id,
    analyte,
    unit,
    referenceLow: opts.low ?? null,
    referenceHigh: opts.high ?? null,
    panel: opts.panel ?? null,
    takenAt: new Date(takenAt),
  };
}

describe("groupRowsByAnalyte", () => {
  it("collapses case/spacing variants of the same analyte into one group", () => {
    const groups = groupRowsByAnalyte([
      row("a", "LDL", "mg/dL", "2026-01-01T00:00:00Z"),
      row("b", "ldl", "mg/dl", "2026-02-01T00:00:00Z"),
      row("c", " LDL ", "mg/dL", "2026-03-01T00:00:00Z"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("uses the most-recently-taken reading for the canonical name/unit/range", () => {
    // Same analyte key ("ldl"), case + unit + range drift across reports —
    // the newest report's spelling/unit/range wins.
    const groups = groupRowsByAnalyte([
      row("old", "ldl", "mg/dl", "2026-01-01T00:00:00Z", { high: 100 }),
      row("new", "LDL", "mg/dL", "2026-06-01T00:00:00Z", { high: 116 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("LDL");
    expect(groups[0].unit).toBe("mg/dL");
    expect(groups[0].referenceHigh).toBe(116);
  });

  it("keeps distinct analytes in separate groups", () => {
    const groups = groupRowsByAnalyte([
      row("a", "LDL", "mg/dL", "2026-01-01T00:00:00Z"),
      row("b", "HDL", "mg/dL", "2026-01-01T00:00:00Z"),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("skips a row with a blank analyte", () => {
    const groups = groupRowsByAnalyte([
      row("a", "   ", "mg/dL", "2026-01-01T00:00:00Z"),
      row("b", "LDL", "mg/dL", "2026-01-01T00:00:00Z"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("LDL");
  });
});
