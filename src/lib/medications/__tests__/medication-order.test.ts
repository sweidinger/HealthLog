/**
 * v1.16.10 — the manual medication order shared by BOTH /medications
 * views. Ordered ids first (in saved order), everything else appends in
 * the alphabetical default; unknown ids are ignored.
 */
import { describe, expect, it } from "vitest";

import { applyMedicationOrder } from "@/lib/medications/medication-order";

const meds = [
  { id: "m1", name: "Ramipril" },
  { id: "m2", name: "Aspirin" },
  { id: "m3", name: "Mounjaro" },
];

describe("applyMedicationOrder", () => {
  it("returns the alphabetical default for an empty order", () => {
    expect(applyMedicationOrder(meds, []).map((m) => m.name)).toEqual([
      "Aspirin",
      "Mounjaro",
      "Ramipril",
    ]);
  });

  it("applies the saved order verbatim when every id is named", () => {
    expect(
      applyMedicationOrder(meds, ["m3", "m1", "m2"]).map((m) => m.id),
    ).toEqual(["m3", "m1", "m2"]);
  });

  it("appends unnamed medications alphabetically after the ordered block", () => {
    // A medication created after the last order save must surface, not
    // vanish — it lands after the ordered block in the default order.
    expect(applyMedicationOrder(meds, ["m3"]).map((m) => m.id)).toEqual([
      "m3",
      "m2", // Aspirin
      "m1", // Ramipril
    ]);
  });

  it("ignores ids that no longer resolve to a medication", () => {
    expect(
      applyMedicationOrder(meds, ["deleted-med", "m2"]).map((m) => m.id),
    ).toEqual(["m2", "m3", "m1"]);
  });

  it("does not mutate the input array", () => {
    const input = [...meds];
    applyMedicationOrder(input, ["m3", "m1"]);
    expect(input).toEqual(meds);
  });
});
