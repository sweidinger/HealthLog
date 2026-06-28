import { describe, it, expect } from "vitest";

import {
  summariseLabChanges,
  type LabChangeRow,
} from "@/lib/insights/labs-changes";

function row(
  analyte: string,
  value: number,
  day: string,
  opts: { unit?: string; low?: number | null; high?: number | null } = {},
): LabChangeRow {
  return {
    analyte,
    unit: opts.unit ?? "mg/dL",
    value,
    referenceLow: opts.low ?? null,
    referenceHigh: opts.high ?? null,
    takenAt: new Date(`${day}T08:00:00.000Z`),
  };
}

describe("summariseLabChanges", () => {
  it("is absent with no rows", () => {
    expect(summariseLabChanges([])).toMatchObject({ present: false });
  });

  it("is absent with a single panel", () => {
    const s = summariseLabChanges([row("LDL", 130, "2026-06-01")]);
    expect(s.present).toBe(false);
  });

  it("is absent when no analyte is shared across panels", () => {
    const s = summariseLabChanges([
      row("LDL", 130, "2026-06-01"),
      row("HbA1c", 5.4, "2026-05-01"),
    ]);
    expect(s.present).toBe(false);
  });

  it("pairs the two most-recent panels for a shared analyte", () => {
    const s = summariseLabChanges([
      row("LDL", 120, "2026-06-01", { high: 116 }),
      row("LDL", 140, "2026-05-01"),
      row("LDL", 150, "2026-04-01"),
    ]);
    expect(s.present).toBe(true);
    expect(s.latestDate).toBe("2026-06-01");
    expect(s.previousDate).toBe("2026-05-01");
    expect(s.changes).toHaveLength(1);
    const c = s.changes[0];
    expect(c.latest).toBe(120);
    expect(c.previous).toBe(140);
    expect(c.delta).toBe(-20);
    expect(c.direction).toBe("down");
    expect(c.status).toBe("above");
  });

  it("skips qualitative (non-finite) values", () => {
    const s = summariseLabChanges([
      row("LDL", Number.NaN, "2026-06-01"),
      row("LDL", 140, "2026-05-01"),
    ]);
    expect(s.present).toBe(false);
  });
});
