import { describe, it, expect } from "vitest";

import { formatDose } from "@/lib/medications/format-dose";

/**
 * The unit keys translate via `medications.wizard.steps.step3.unit.<key>`.
 * The stub mirrors a German bundle for the keys under test and echoes the
 * key for anything else so a wrong lookup is visible.
 */
const t = (key: string): string =>
  ({
    "medications.wizard.steps.step3.unit.pieces": "Stück",
    "medications.wizard.steps.step3.unit.mg": "mg",
    "medications.wizard.steps.step3.unit.tablets": "Tablette(n)",
  })[key] ?? key;

describe("formatDose", () => {
  it("translates a raw unit key glued to an amount", () => {
    expect(formatDose("1 pieces", t)).toBe("1 Stück");
  });

  it("keeps a numeric amount and translates the unit", () => {
    expect(formatDose("5 mg", t)).toBe("5 mg");
    expect(formatDose("2 tablets", t)).toBe("2 Tablette(n)");
  });

  it("passes a custom free-text dose through unchanged", () => {
    expect(formatDose("1 puff morning", t)).toBe("1 puff morning");
  });

  it("returns an empty string for empty / null / undefined input", () => {
    expect(formatDose("", t)).toBe("");
    expect(formatDose(null, t)).toBe("");
    expect(formatDose(undefined, t)).toBe("");
  });
});
