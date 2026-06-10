/**
 * v1.15.20 — coverage for the shared card window-status helper.
 *
 * Pins the three model fixes:
 *   - the wall-clock conversion honours an explicit IANA timezone (the
 *     Berlin default stays byte-stable for the legacy call sites);
 *   - a degenerate `windowStart === windowEnd` schedule reads as a POINT
 *     window widened by the default daily on-time half-width — not as a
 *     24 h overnight band that kept the pill in `in_window` all day;
 *   - `countPassedSchedules` counts `timesOfDay` doses, not schedule rows,
 *     so a two-dose row keeps the overdue pill up until BOTH doses are
 *     covered by today's intake events.
 */
import { describe, expect, it } from "vitest";

import {
  reduceCurrentWindowStatus,
  toBerlinDate,
  toZonedDate,
} from "../window-status";

/** Build a local wall-clock Date (what the cards pass as `nowBerlin`). */
function localClock(hours: number, minutes = 0): Date {
  // Wednesday, June 10 2026 — weekday-agnostic fixtures (no daysOfWeek).
  return new Date(2026, 5, 10, hours, minutes, 0, 0);
}

const BASE = {
  lateMinutes: 120,
  missedMinutes: 240,
  active: true,
  lastTakenAt: null,
  todayEventCount: 0,
};

describe("toZonedDate", () => {
  it("shifts an instant into the requested timezone's wall clock", () => {
    const instant = new Date("2026-06-10T12:00:00Z");
    expect(toZonedDate(instant, "Europe/Berlin").getHours()).toBe(14); // CEST
    expect(toZonedDate(instant, "America/New_York").getHours()).toBe(8); // EDT
  });

  it("toBerlinDate stays the Berlin alias for legacy call sites", () => {
    const instant = new Date("2026-06-10T12:00:00Z");
    expect(toBerlinDate(instant).getTime()).toBe(
      toZonedDate(instant, "Europe/Berlin").getTime(),
    );
  });
});

describe("reduceCurrentWindowStatus — timezone threading", () => {
  it("compares lastTakenAt in the supplied timezone, not hardcoded Berlin", () => {
    // 08:30 local in New York = 12:30 UTC. With tz=America/New_York the
    // last intake falls inside the 08:00–09:00 window and the in_window
    // pill is suppressed; under the Berlin default the same instant reads
    // as 14:30 local (outside the window) and the pill would show.
    const schedules = [
      { windowStart: "08:00", windowEnd: "09:00", daysOfWeek: null },
    ];
    const nowLocal = localClock(8, 45);

    const withUserTz = reduceCurrentWindowStatus({
      ...BASE,
      schedules,
      nowBerlin: nowLocal,
      lastTakenAt: "2026-06-10T12:30:00Z",
      todayEventCount: 1,
      tz: "America/New_York",
    });
    expect(withUserTz.status).toBeNull();

    const withDefaultTz = reduceCurrentWindowStatus({
      ...BASE,
      schedules,
      nowBerlin: nowLocal,
      lastTakenAt: "2026-06-10T12:30:00Z",
      todayEventCount: 1,
    });
    expect(withDefaultTz.status).toBe("in_window");
  });
});

describe("reduceCurrentWindowStatus — degenerate point window", () => {
  const pointSchedule = [
    { windowStart: "08:00", windowEnd: "08:00", daysOfWeek: null },
  ];

  it("does NOT read as in_window all day (the old 24 h overnight bug)", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: pointSchedule,
      nowBerlin: localClock(15, 0),
    });
    // 15:00 is hours past the widened 07:00–09:00 point window and past
    // the late + missed thresholds → no pill at all.
    expect(res.status).toBeNull();
  });

  it("is in_window inside the default ±60 min widening", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: pointSchedule,
      nowBerlin: localClock(8, 30),
    });
    expect(res.status).toBe("in_window");
  });

  it("turns late shortly after the widened window end", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: pointSchedule,
      nowBerlin: localClock(10, 0),
    });
    // Window end 09:00 + 60 min past → late tier.
    expect(res.status).toBe("late");
  });

  it("keeps a genuine overnight window on the wrap-around path", () => {
    const overnight = [
      { windowStart: "22:00", windowEnd: "02:00", daysOfWeek: null },
    ];
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: overnight,
      nowBerlin: localClock(23, 30),
    });
    expect(res.status).toBe("in_window");
  });
});

describe("reduceCurrentWindowStatus — timesOfDay-aware overdue coverage", () => {
  // One schedule row, two dose times, window long past at 22:00.
  const twoDoseSchedule = [
    {
      windowStart: "08:00",
      windowEnd: "20:00",
      daysOfWeek: null,
      timesOfDay: ["08:00", "20:00"],
    },
  ];

  it("keeps the overdue pill when only one of two doses is covered", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: twoDoseSchedule,
      nowBerlin: localClock(21, 0),
      todayEventCount: 1,
    });
    // One event covers one dose; the second passed dose is uncovered →
    // the late pill must stay up. (Pre-v1.15.20 the row counted as ONE
    // expected dose and the pill vanished here.)
    expect(res.status).toBe("late");
  });

  it("suppresses the pill once both doses are covered", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: twoDoseSchedule,
      nowBerlin: localClock(21, 0),
      todayEventCount: 2,
    });
    expect(res.status).toBeNull();
  });

  it("a schedule without timesOfDay keeps counting as one dose", () => {
    const legacy = [
      { windowStart: "08:00", windowEnd: "20:00", daysOfWeek: null },
    ];
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: legacy,
      nowBerlin: localClock(21, 0),
      todayEventCount: 1,
    });
    expect(res.status).toBeNull();
  });
});
