/**
 * v1.15.20 — supply-runway estimate behind the detail Übersicht's
 * "lasts about N more days" line. Pure helpers, no render needed.
 */

import { describe, it, expect } from "vitest";

import {
  estimateDailyDoseCount,
  estimateRunwayDays,
  type RunwaySchedule,
} from "@/components/medications/detail/supply-runway";

function schedule(partial: Partial<RunwaySchedule>): RunwaySchedule {
  return {
    windowStart: "08:00",
    daysOfWeek: null,
    ...partial,
  };
}

describe("estimateDailyDoseCount", () => {
  it("counts a plain daily schedule as its times-of-day per day", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00", "20:00"] }),
      ]),
    ).toBe(2);
  });

  it("falls back to one dose per day when timesOfDay is absent", () => {
    expect(estimateDailyDoseCount([schedule({})])).toBe(1);
  });

  it("scales a rolling interval down (one dose every N days)", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 }),
      ]),
    ).toBeCloseTo(1 / 7);
  });

  it("scales weekday picks against the 7-day week", () => {
    // Mon/Wed/Fri → 3 doses per 7 days.
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], daysOfWeek: "1,3,5" }),
      ]),
    ).toBeCloseTo(3 / 7);
  });

  it("honours the encoded interval-weeks cadence", () => {
    // Every 2nd week on one weekday → 1 dose per 14 days.
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], daysOfWeek: "i2;1" }),
      ]),
    ).toBeCloseTo(1 / 14);
  });

  it("approximates a monthly RRULE at one dose per 30 days", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], rrule: "FREQ=MONTHLY;BYMONTHDAY=1" }),
      ]),
    ).toBeCloseTo(1 / 30);
  });

  it("sums across multiple schedules", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"] }),
        schedule({ timesOfDay: ["20:00"] }),
      ]),
    ).toBe(2);
  });
});

describe("estimateRunwayDays", () => {
  it("divides the remaining doses by the daily consumption", () => {
    expect(
      estimateRunwayDays(14, [schedule({ timesOfDay: ["08:00", "20:00"] })]),
    ).toBe(7);
  });

  it("floors to whole days", () => {
    expect(estimateRunwayDays(5, [schedule({ timesOfDay: ["08:00", "20:00"] })])).toBe(
      2,
    );
  });

  it("returns null when no supply remains", () => {
    expect(estimateRunwayDays(0, [schedule({})])).toBeNull();
  });

  it("returns null when no schedule consumes doses", () => {
    expect(estimateRunwayDays(10, [])).toBeNull();
  });

  it("covers the weekly injection case (rolling 7-day pen)", () => {
    // 4 doses left on a once-a-week injection → ~28 days.
    expect(
      estimateRunwayDays(4, [
        schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 }),
      ]),
    ).toBe(28);
  });
});
