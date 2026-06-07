import { describe, it, expect } from "vitest";

import { deriveWheelState, currentCycleStartDate } from "../wheel-state";
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
    basalBodyTempC: null,
    ovulationTest: null,
    cervicalMucus: null,
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
    // A well-populated run (>= 7 labelled days spanning all four phases) keeps
    // the OBSERVED-share spans. Eight forward-labelled days exercise the
    // observed path (above the sparse threshold).
    const days = [
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
      day("2026-06-03", "MENSTRUAL"),
      day("2026-06-04", "FOLLICULAR"),
      day("2026-06-05", "FOLLICULAR"),
      day("2026-06-06", "OVULATORY"),
      day("2026-06-07", "LUTEAL"),
      day("2026-06-08", "LUTEAL"),
    ];
    const w = deriveWheelState(days, "2026-06-05");
    const total = w.spans.reduce((s, x) => s + x.fraction, 0);
    expect(total).toBeCloseTo(1, 5);
    // All four observed phases are emitted, and the observed cycle length
    // matches the labelled run (8 days) — NOT the idealized fallback length.
    expect(w.spans.map((s) => s.phase).sort()).toEqual([
      "FOLLICULAR",
      "LUTEAL",
      "MENSTRUAL",
      "OVULATORY",
    ]);
    expect(w.cycleLength).toBe(8);
  });

  it("falls back to canonical four-phase spans for a low-data tracker", () => {
    // Only the first few days of a first-ever cycle are logged — a 2-day
    // menstrual run. The observed-share path would normalise this so MENSTRUAL
    // filled (nearly) the whole ring. The low-data fallback instead draws the
    // canonical four phases from the profile lengths.
    const days = [
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
    ];
    const w = deriveWheelState(days, "2026-06-02", {
      typicalCycleLength: 28,
      typicalPeriodLength: 5,
      lutealPhaseLength: 14,
    });

    // The marker read stays driven by the observed labels.
    expect(w.dayOfCycle).toBe(2);
    expect(w.phase).toBe("MENSTRUAL");

    // FOUR sensible arcs, not one dominant sliver. The idealized cycle length
    // (5 + follicular + 2 + 14 = 28) is represented, and no single phase
    // swallows the ring.
    expect(w.spans).toHaveLength(4);
    expect(w.spans.map((s) => s.phase)).toEqual([
      "MENSTRUAL",
      "FOLLICULAR",
      "OVULATORY",
      "LUTEAL",
    ]);
    const total = w.spans.reduce((s, x) => s + x.fraction, 0);
    expect(total).toBeCloseTo(1, 5);
    for (const span of w.spans) {
      expect(span.fraction).toBeGreaterThan(0);
      expect(span.fraction).toBeLessThan(0.95);
    }
    expect(w.cycleLength).toBe(28);
  });

  it("uses textbook defaults for the low-data ring when no profile is given", () => {
    const days = [day("2026-06-01", "MENSTRUAL")];
    const w = deriveWheelState(days, "2026-06-01");
    expect(w.spans).toHaveLength(4);
    // Defaults: 28-day cycle.
    expect(w.cycleLength).toBe(28);
    expect(w.phase).toBe("MENSTRUAL");
    expect(w.dayOfCycle).toBe(1);
  });
});

describe("currentCycleStartDate", () => {
  it("returns the most recent menstrual run-start at/before today", () => {
    const days = [
      day("2026-05-30", "LUTEAL"),
      day("2026-06-01", "MENSTRUAL"),
      day("2026-06-02", "MENSTRUAL"),
      day("2026-06-03", "FOLLICULAR"),
      day("2026-06-04", "FOLLICULAR"),
    ];
    expect(currentCycleStartDate(days, "2026-06-04")).toBe("2026-06-01");
  });

  it("returns null when today carries no phase", () => {
    const days = [day("2026-06-01", null), day("2026-06-02", null)];
    expect(currentCycleStartDate(days, "2026-06-02")).toBeNull();
  });

  it("returns null when today is absent from the calendar", () => {
    const days = [day("2026-06-01", "MENSTRUAL")];
    expect(currentCycleStartDate(days, "2026-06-09")).toBeNull();
  });
});
