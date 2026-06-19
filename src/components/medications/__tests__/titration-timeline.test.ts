/**
 * v1.18.5 — titration-timeline step-builder tests.
 *
 * Pins `buildTitrationSteps`: chronological sort, past/planned split at
 * "now", and the single current-step tag (the latest step already in
 * effect). The render is exercised indirectly through these seams; the
 * pure builder carries the classification logic the component renders.
 */

import { describe, it, expect } from "vitest";

import { buildTitrationSteps } from "../titration-timeline";

const ASOF = new Date("2026-06-18T12:00:00Z");

function change(id: string, iso: string, dose: number) {
  return { id, effectiveFrom: iso, doseValue: dose, doseUnit: "mg" };
}

describe("buildTitrationSteps", () => {
  it("returns an empty array for no dose changes", () => {
    expect(buildTitrationSteps([], ASOF)).toEqual([]);
  });

  it("sorts by effective date and classifies past vs planned at now", () => {
    const steps = buildTitrationSteps(
      [
        change("c", "2026-08-01T00:00:00Z", 7.5), // future
        change("a", "2026-04-01T00:00:00Z", 2.5), // past
        change("b", "2026-06-01T00:00:00Z", 5), // past
      ],
      ASOF,
    );
    expect(steps.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(steps.map((s) => s.isPast)).toEqual([true, true, false]);
  });

  it("tags only the latest in-effect step as current", () => {
    const steps = buildTitrationSteps(
      [
        change("a", "2026-04-01T00:00:00Z", 2.5),
        change("b", "2026-06-01T00:00:00Z", 5),
        change("c", "2026-08-01T00:00:00Z", 7.5),
      ],
      ASOF,
    );
    expect(steps.map((s) => s.isCurrent)).toEqual([false, true, false]);
  });

  it("marks no current step when every step is still planned", () => {
    const steps = buildTitrationSteps(
      [
        change("a", "2026-07-01T00:00:00Z", 2.5),
        change("b", "2026-08-01T00:00:00Z", 5),
      ],
      ASOF,
    );
    expect(steps.some((s) => s.isCurrent)).toBe(false);
    expect(steps.every((s) => !s.isPast)).toBe(true);
  });

  it("drops rows with unparseable dates or non-finite doses", () => {
    const steps = buildTitrationSteps(
      [
        change("a", "2026-04-01T00:00:00Z", 2.5),
        change("bad", "not-a-date", 5),
        {
          id: "nan",
          effectiveFrom: "2026-05-01T00:00:00Z",
          doseValue: NaN,
          doseUnit: "mg",
        },
      ],
      ASOF,
    );
    expect(steps.map((s) => s.id)).toEqual(["a"]);
  });
});
