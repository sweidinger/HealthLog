/**
 * v1.16.1 — care-routine metric helpers.
 *
 * Pins:
 *   - miss-free day qualification: resolved (taken or deliberately
 *     skipped) days qualify, any auto-missed slot disqualifies the day,
 *     pending-only days stay out of the series entirely;
 *   - weekly measurement consistency: Monday-anchored weeks, the
 *     ≥5-distinct-days threshold, consecutive-week runs, and the
 *     completion day key (the 5th active day of the run's final week).
 */
import { describe, it, expect } from "vitest";

import { calculateLongestStreak } from "../achievements";
import {
  getMissFreeDayKeys,
  getWeeklyConsistency,
  type CareIntakeEventRecord,
} from "../care-metrics";

function event(
  isoDay: string,
  overrides: Partial<CareIntakeEventRecord> = {},
): CareIntakeEventRecord {
  return {
    // 10:00 UTC sits mid-day in Europe/Berlin both winter and summer,
    // so the Berlin day key always equals `isoDay`.
    scheduledFor: new Date(`${isoDay}T10:00:00Z`),
    takenAt: new Date(`${isoDay}T10:05:00Z`),
    skipped: false,
    autoMissed: false,
    ...overrides,
  };
}

describe("getMissFreeDayKeys", () => {
  it("qualifies days where every resolved slot landed without an auto-miss", () => {
    const keys = getMissFreeDayKeys([
      event("2026-05-01"),
      event("2026-05-02"),
      event("2026-05-03"),
    ]);
    expect(keys).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
    expect(calculateLongestStreak(keys)).toBe(3);
  });

  it("disqualifies a day with any auto-missed slot, breaking the streak", () => {
    const keys = getMissFreeDayKeys([
      event("2026-05-01"),
      event("2026-05-02"),
      // Second slot of the day forgotten → the whole day is out.
      event("2026-05-02", { takenAt: null, autoMissed: true }),
      event("2026-05-03"),
    ]);
    expect(keys).toEqual(["2026-05-01", "2026-05-03"]);
    expect(calculateLongestStreak(keys)).toBe(1);
  });

  it("counts a deliberate skip as a resolved day (a planned break is not a miss)", () => {
    const keys = getMissFreeDayKeys([
      event("2026-05-01"),
      event("2026-05-02", { takenAt: null, skipped: true }),
      event("2026-05-03"),
    ]);
    expect(calculateLongestStreak(keys)).toBe(3);
  });

  it("leaves a pending-only day out of the series without counting it as a miss", () => {
    const keys = getMissFreeDayKeys([
      event("2026-05-01"),
      // Today: slot exists but is unresolved — not yet decided.
      event("2026-05-02", { takenAt: null }),
    ]);
    expect(keys).toEqual(["2026-05-01"]);
  });
});

describe("getWeeklyConsistency", () => {
  /** Mon 2026-05-04 .. Sun 2026-05-10 is one Berlin/ISO week. */
  function weekDays(mondayIso: string, count: number): string[] {
    const [y, m, d] = mondayIso.split("-").map(Number);
    return Array.from({ length: count }, (_, i) => {
      const date = new Date(Date.UTC(y, m - 1, d + i));
      return date.toISOString().slice(0, 10);
    });
  }

  it("counts consecutive weeks with at least minDaysPerWeek distinct days", () => {
    const days = [
      ...weekDays("2026-05-04", 5),
      ...weekDays("2026-05-11", 6),
      ...weekDays("2026-05-18", 5),
      ...weekDays("2026-05-25", 5),
    ];
    const result = getWeeklyConsistency(days, 5, 4);
    expect(result.longestRunWeeks).toBe(4);
    // The run completes on the 5th active day of the 4th week.
    expect(result.completionDayKey).toBe("2026-05-29");
  });

  it("a 4-day week breaks the run and resets it", () => {
    const days = [
      ...weekDays("2026-05-04", 5),
      ...weekDays("2026-05-11", 4), // below threshold
      ...weekDays("2026-05-18", 5),
      ...weekDays("2026-05-25", 5),
    ];
    const result = getWeeklyConsistency(days, 5, 4);
    expect(result.longestRunWeeks).toBe(2);
    expect(result.completionDayKey).toBeNull();
  });

  it("a calendar gap between qualifying weeks breaks the run", () => {
    const days = [
      ...weekDays("2026-05-04", 5),
      // 2026-05-11 week missing entirely.
      ...weekDays("2026-05-18", 5),
    ];
    const result = getWeeklyConsistency(days, 5, 4);
    expect(result.longestRunWeeks).toBe(1);
  });

  it("duplicate day keys within a week count once", () => {
    const days = [
      ...weekDays("2026-05-04", 3),
      ...weekDays("2026-05-04", 3), // duplicates
    ];
    const result = getWeeklyConsistency(days, 5, 4);
    expect(result.longestRunWeeks).toBe(0);
  });

  it("handles an empty series", () => {
    const result = getWeeklyConsistency([], 5, 4);
    expect(result).toEqual({ longestRunWeeks: 0, completionDayKey: null });
  });
});
