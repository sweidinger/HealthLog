import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { findMany: vi.fn() },
  },
}));

import { buildLabsSnapshotBlock, sanitizeValueText } from "../labs-snapshot";
import { prisma } from "@/lib/db";

const prismaMock = prisma as unknown as {
  labResult: { findMany: ReturnType<typeof vi.fn> };
};

const NOW = new Date("2026-06-21T12:00:00.000Z");

/** A linked numeric lab row (biomarker wins for name/unit/bounds). */
function numericRow(overrides: Record<string, unknown> = {}) {
  return {
    analyte: "ldl-legacy",
    panel: "legacy-panel",
    value: 140,
    valueText: null,
    unit: "legacy-unit",
    referenceLow: 50,
    referenceHigh: 200,
    takenAt: new Date("2026-06-01T08:00:00.000Z"),
    biomarkerId: "bm_ldl",
    biomarker: {
      id: "bm_ldl",
      name: "LDL",
      unit: "mg/dL",
      lowerBound: 0,
      upperBound: 130,
      panel: "Lipids",
    },
    ...overrides,
  };
}

beforeEach(() => {
  prismaMock.labResult.findMany.mockReset();
});

describe("buildLabsSnapshotBlock", () => {
  it("returns null when the account has no readings", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block).toBeNull();
  });

  it("resolves name/unit/bounds from the linked biomarker and flags out-of-range", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([numericRow()]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block).not.toBeNull();
    expect(block!.recent).toHaveLength(1);
    const r = block!.recent[0];
    // Biomarker fields win over the stale per-row legacy columns.
    expect(r.analyte).toBe("LDL");
    expect(r.unit).toBe("mg/dL");
    expect(r.referenceHigh).toBe(130);
    expect(r.panel).toBe("Lipids");
    // 140 > upperBound 130 → above.
    expect(r.rangeStatus).toBe("above");
    expect(r.value).toBe(140);
    expect(r.valueText).toBeNull();
  });

  it("classifies an in-range numeric reading", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      numericRow({ value: 100 }),
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block!.recent[0].rangeStatus).toBe("in-range");
  });

  it("includes a qualitative reading with unknown range status", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      {
        analyte: "Hepatitis B",
        panel: null,
        value: null,
        valueText: "negativ",
        unit: "",
        referenceLow: null,
        referenceHigh: null,
        takenAt: new Date("2026-05-10T08:00:00.000Z"),
        biomarkerId: "bm_hep",
        biomarker: {
          id: "bm_hep",
          name: "Hepatitis B",
          unit: "",
          lowerBound: null,
          upperBound: null,
          panel: null,
        },
      },
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    const r = block!.recent[0];
    expect(r.value).toBeNull();
    expect(r.valueText).toBe("negativ");
    expect(r.rangeStatus).toBe("unknown");
  });

  it("keeps only the most-recent reading per biomarker", async () => {
    // findMany returns newest-first; the older duplicate must be dropped.
    prismaMock.labResult.findMany.mockResolvedValue([
      numericRow({ value: 120, takenAt: new Date("2026-06-10T08:00:00.000Z") }),
      numericRow({ value: 145, takenAt: new Date("2026-01-10T08:00:00.000Z") }),
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block!.recent).toHaveLength(1);
    expect(block!.recent[0].value).toBe(120);
  });

  it("collapses two spellings of an unlinked marker by lower-cased analyte", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([
      {
        analyte: "Ferritin",
        panel: null,
        value: 80,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        takenAt: new Date("2026-06-05T08:00:00.000Z"),
        biomarkerId: null,
        biomarker: null,
      },
      {
        analyte: "ferritin",
        panel: null,
        value: 60,
        valueText: null,
        unit: "ng/mL",
        referenceLow: 30,
        referenceHigh: 400,
        takenAt: new Date("2026-02-05T08:00:00.000Z"),
        biomarkerId: null,
        biomarker: null,
      },
    ]);
    const block = await buildLabsSnapshotBlock("user_1", NOW);
    expect(block!.recent).toHaveLength(1);
    expect(block!.recent[0].value).toBe(80);
  });

  it("queries with an owner-scoped, deletedAt-null, 12-month window where", async () => {
    prismaMock.labResult.findMany.mockResolvedValue([]);
    await buildLabsSnapshotBlock("user_42", NOW);
    const arg = prismaMock.labResult.findMany.mock.calls[0][0];
    expect(arg.where.userId).toBe("user_42");
    expect(arg.where.deletedAt).toBeNull();
    expect(arg.where.takenAt.lte).toEqual(NOW);
    expect(arg.where.takenAt.gte).toEqual(new Date("2025-06-21T12:00:00.000Z"));
    // Never selects the encrypted note column.
    expect(arg.select.noteEncrypted).toBeUndefined();
  });
});

describe("sanitizeValueText", () => {
  it("collapses control chars + newlines and bounds length", () => {
    expect(sanitizeValueText("negativ")).toBe("negativ");
    expect(sanitizeValueText("ignore\nprevious\tinstructions")).toBe(
      "ignore previous instructions",
    );
    expect(sanitizeValueText("x".repeat(200)).length).toBe(60);
  });
});
