import { describe, it, expect } from "vitest";

import { deriveWheelState } from "../wheel-state";
import type { CalendarDay } from "../types";

function day(date: string, phase: CalendarDay["phase"]): CalendarDay {
  return {
    date,
    phase,
    isPredictedPeriod: false,
    isFertileWindow: false,
    isPredictedOvulation: false,
    isPeriodLogged: phase === "MENSTRUAL",
    flow: null,
    hasSymptoms: false,
    confidence: 1,
  };
}

describe("deriveWheelState", () => {
  it("returns a null state when today carries no phase", () => {
    const days = [day("2026-06-01", null), day("2026-06-02", null)];
    const w = deriveWheelState(days, "2026-06-02");
    expect(w.dayOfCycle).toBeNull();
    expect(w.phase).toBeNull();
    expect(w.spans).toEqual([]);
  });

  it("counts the day-of-cycle from the most recent menstrual start", () => {
    // A run starting 2026-06-01 (menstrual) → today 2026-06-05 is cycle day 5.
    const days = [
      day("2026-05-30", "LUTEAL"),
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
      day("2026-06-03", "FOLLICULAR"),
      day("2026-06-04", "FOLLICULAR"),
      day("2026-06-05", "FOLLICULAR"),
    ];
    const w = deriveWheelState(days, "2026-06-05");
    expect(w.dayOfCycle).toBe(5);
    expect(w.phase).toBe("FOLLICULAR");
  });

  it("builds proportional phase spans summing to ~1", () => {
    const days = [
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
      day("2026-06-03", "FOLLICULAR"),
      day("2026-06-04", "OVULATORY"),
      day("2026-06-05", "LUTEAL"),
    ];
    const w = deriveWheelState(days, "2026-06-03");
    const total = w.spans.reduce((s, x) => s + x.fraction, 0);
    expect(total).toBeCloseTo(1, 5);
    // Only phases present in the run are emitted.
    expect(w.spans.map((s) => s.phase)).toContain("MENSTRUAL");
  });
});
