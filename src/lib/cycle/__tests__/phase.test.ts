import { describe, expect, it } from "vitest";

import { addDays } from "../day-math";
import { phaseForDay, phaseSeries, type PhaseCycle } from "../phase";

/**
 * Phase boundary tests. A 28-day cycle starting 2024-01-01, period 5 days,
 * ovulation on day-14 (offset 13 → 2024-01-14). Boundaries per §"Phase channel":
 *   MENSTRUAL  offsets 0..4   (2024-01-01 .. 2024-01-05)
 *   FOLLICULAR offsets 5..11  (2024-01-06 .. 2024-01-12)
 *   OVULATORY  offsets 12..14 (2024-01-13 .. 2024-01-15)  [ov-1 .. ov+1]
 *   LUTEAL     offsets 15..27 (2024-01-16 .. 2024-01-28)
 */
const CYCLE: PhaseCycle = {
  startDate: "2024-01-01",
  nextStart: "2024-01-29", // 28-day cycle
  ovulationDate: "2024-01-14",
  periodLength: 5,
  lutealLength: 14,
};

describe("cycle/phase — boundary mapping (§Phase channel)", () => {
  it("menstrual window [start, start+P-1]", () => {
    expect(phaseForDay("2024-01-01", CYCLE).phase).toBe("MENSTRUAL");
    expect(phaseForDay("2024-01-05", CYCLE).phase).toBe("MENSTRUAL");
    // day 6 is the first follicular day.
    expect(phaseForDay("2024-01-06", CYCLE).phase).toBe("FOLLICULAR");
  });

  it("follicular window (period end, ovulatory start)", () => {
    expect(phaseForDay("2024-01-06", CYCLE).phase).toBe("FOLLICULAR");
    expect(phaseForDay("2024-01-12", CYCLE).phase).toBe("FOLLICULAR");
    // 2024-01-13 is ov-1 → ovulatory begins.
    expect(phaseForDay("2024-01-13", CYCLE).phase).toBe("OVULATORY");
  });

  it("ovulatory 3-day window [ov-1, ov+1]", () => {
    expect(phaseForDay("2024-01-13", CYCLE).phase).toBe("OVULATORY");
    expect(phaseForDay("2024-01-14", CYCLE).phase).toBe("OVULATORY");
    expect(phaseForDay("2024-01-15", CYCLE).phase).toBe("OVULATORY");
    // 2024-01-16 starts luteal.
    expect(phaseForDay("2024-01-16", CYCLE).phase).toBe("LUTEAL");
  });

  it("luteal window (ovulatory end, nextStart)", () => {
    expect(phaseForDay("2024-01-16", CYCLE).phase).toBe("LUTEAL");
    expect(phaseForDay("2024-01-28", CYCLE).phase).toBe("LUTEAL");
  });

  it("1-based day-of-cycle is exact", () => {
    expect(phaseForDay("2024-01-01", CYCLE).dayOfCycle).toBe(1);
    expect(phaseForDay("2024-01-14", CYCLE).dayOfCycle).toBe(14);
    expect(phaseForDay("2024-01-28", CYCLE).dayOfCycle).toBe(28);
  });

  it("dates outside [start, nextStart) return null", () => {
    expect(phaseForDay("2023-12-31", CYCLE).phase).toBeNull();
    expect(phaseForDay("2023-12-31", CYCLE).dayOfCycle).toBeNull();
    // nextStart itself belongs to the NEXT cycle, not this one.
    expect(phaseForDay("2024-01-29", CYCLE).phase).toBeNull();
  });

  it("MENSTRUAL precedence: a bleeding day wins even if it overlaps another window", () => {
    // A short cycle where the ovulatory window would mathematically overlap the
    // period: period 5, but ovulation pulled early to offset 4 (2024-01-05).
    const overlap: PhaseCycle = {
      startDate: "2024-01-01",
      nextStart: "2024-01-15",
      ovulationDate: "2024-01-05", // ov-1 = 2024-01-04 collides with menstrual
      periodLength: 5,
      lutealLength: 10,
    };
    // 2024-01-04 is within both the menstrual [0..4] and ovulatory [3..5] windows
    // → MENSTRUAL wins.
    expect(phaseForDay("2024-01-04", overlap).phase).toBe("MENSTRUAL");
    // 2024-01-06 is past the period → ovulatory (ov+1).
    expect(phaseForDay("2024-01-06", overlap).phase).toBe("OVULATORY");
  });

  it("estimates ovulation from length/luteal when ovulationDate is null", () => {
    const noOv: PhaseCycle = {
      startDate: "2024-01-01",
      nextStart: "2024-01-29", // length 28
      ovulationDate: null,
      periodLength: 5,
      lutealLength: 14,
    };
    // estimated ovulation = start + (28 - 14) = offset 14 → 2024-01-15.
    expect(phaseForDay("2024-01-15", noOv).phase).toBe("OVULATORY");
    expect(phaseForDay("2024-01-14", noOv).phase).toBe("OVULATORY"); // ov-1
    expect(phaseForDay("2024-01-13", noOv).phase).toBe("FOLLICULAR");
  });

  it("defaults period length + luteal length when omitted", () => {
    const bare: PhaseCycle = {
      startDate: "2024-01-01",
      nextStart: "2024-01-29",
      ovulationDate: null,
      periodLength: null,
    };
    // period default 5 → day 5 menstrual, day 6 follicular.
    expect(phaseForDay("2024-01-05", bare).phase).toBe("MENSTRUAL");
    expect(phaseForDay("2024-01-06", bare).phase).toBe("FOLLICULAR");
  });
});

describe("cycle/phase — phaseSeries", () => {
  it("emits a categorical value per day across the span", () => {
    const series = phaseSeries("2024-01-01", "2024-01-28", CYCLE);
    expect(series).toHaveLength(28);
    expect(series[0]).toEqual({ date: "2024-01-01", phase: "MENSTRUAL", dayOfCycle: 1 });
    expect(series[27]).toEqual({ date: "2024-01-28", phase: "LUTEAL", dayOfCycle: 28 });
  });

  it("marks out-of-cycle days null at the span edges", () => {
    const series = phaseSeries("2023-12-30", "2024-01-02", CYCLE);
    expect(series[0].phase).toBeNull(); // 2023-12-30 before start
    expect(series[1].phase).toBeNull(); // 2023-12-31 before start
    expect(series[2].phase).toBe("MENSTRUAL"); // 2024-01-01
  });

  it("is timezone-independent across a DST boundary", () => {
    // A cycle spanning the 2024-03-10 US DST change; the noon-UTC anchor keeps
    // day-of-cycle exact.
    const dstCycle: PhaseCycle = {
      startDate: "2024-03-01",
      nextStart: "2024-03-29",
      ovulationDate: "2024-03-14",
      periodLength: 5,
      lutealLength: 14,
    };
    expect(phaseForDay("2024-03-14", dstCycle).dayOfCycle).toBe(14);
    expect(phaseForDay("2024-03-14", dstCycle).phase).toBe("OVULATORY");
    expect(phaseForDay(addDays("2024-03-01", 27), dstCycle).dayOfCycle).toBe(28);
  });
});
