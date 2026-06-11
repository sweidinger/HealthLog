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
  // One schedule row, two dose times. v1.16.1: each dose carries its own
  // ±60 min band (07:00–09:00 and 19:00–21:00); the legacy row window is
  // ignored once timesOfDay exists.
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
      nowBerlin: localClock(21, 30),
      todayEventCount: 1,
    });
    // 21:30 — both bands have passed (ends 09:00 + 21:00); one event
    // covers one dose; the second passed dose is uncovered → the late
    // pill must stay up. (Pre-v1.15.20 the row counted as ONE expected
    // dose and the pill vanished here.)
    expect(res.status).toBe("late");
    expect(res.window).toEqual({
      timeOfDay: "20:00",
      start: "19:00",
      end: "21:00",
    });
  });

  it("suppresses the pill once both doses are covered", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: twoDoseSchedule,
      nowBerlin: localClock(21, 30),
      todayEventCount: 2,
    });
    expect(res.status).toBeNull();
    expect(res.window).toBeNull();
  });

  it("is in_window inside the second dose's own band", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: twoDoseSchedule,
      nowBerlin: localClock(20, 30),
    });
    expect(res.status).toBe("in_window");
    expect(res.window?.timeOfDay).toBe("20:00");
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

describe("reduceCurrentWindowStatus — stale window never beats timesOfDay (v1.16.1)", () => {
  // The production regression: the schedule row still carries the historic
  // degenerate 07:00 / 07:00 window while the dose times moved to
  // 09:00 / 21:00. The 07:00 window must not paint any pill.
  const staleSchedule = [
    {
      windowStart: "07:00",
      windowEnd: "07:00",
      daysOfWeek: null,
      timesOfDay: ["09:00", "21:00"],
    },
  ];

  it("shows NO pill at 07:00 (the stale window used to read in_window)", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: staleSchedule,
      nowBerlin: localClock(7, 0),
    });
    expect(res.status).toBeNull();
  });

  it("is in_window inside the 09:00 dose band, anchored on 09:00", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: staleSchedule,
      nowBerlin: localClock(9, 15),
    });
    expect(res.status).toBe("in_window");
    expect(res.window).toEqual({
      timeOfDay: "09:00",
      start: "08:00",
      end: "10:00",
    });
  });

  it("turns late after the 09:00 band end, still anchored on 09:00", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: staleSchedule,
      nowBerlin: localClock(11, 0),
    });
    expect(res.status).toBe("late");
    expect(res.window?.timeOfDay).toBe("09:00");
  });

  it("honours an explicit doseWindows band over the default derivation", () => {
    const withExplicit = [
      {
        windowStart: "07:00",
        windowEnd: "07:00",
        daysOfWeek: null,
        timesOfDay: ["09:00"],
        doseWindows: [{ timeOfDay: "09:00", start: "08:30", end: "11:30" }],
      },
    ];
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: withExplicit,
      nowBerlin: localClock(11, 0),
    });
    expect(res.status).toBe("in_window");
    expect(res.window).toEqual({
      timeOfDay: "09:00",
      start: "08:30",
      end: "11:30",
    });
  });
});

describe("reduceCurrentWindowStatus — display-due gate (v1.16.6)", () => {
  // Mirrors the production shape that mis-pilled: a rolling 7-day
  // medication (daysOfWeek empty) with a single 08:00 dose and an explicit
  // 08:00–09:00 on-time window. Without the gate the band re-mints every
  // local day and escalates after 09:00 even when the next unresolved slot
  // is tomorrow.
  const rolling = [
    {
      windowStart: "08:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["08:00"],
      doseWindows: [{ timeOfDay: "08:00", start: "08:00", end: "09:00" }],
    },
  ];
  // June 11 2026, 07:00 Berlin (CEST) — "tomorrow" relative to the
  // localClock fixtures (June 10).
  const dueTomorrow = new Date("2026-06-11T05:00:00Z");
  // June 10 2026, 08:00 Berlin — "today's" dose anchor.
  const dueToday = new Date("2026-06-10T06:00:00Z");

  it("rolling med due tomorrow never paints an overdue pill today", () => {
    // Contrast pin: WITHOUT the gate the legacy band model escalates to
    // very_late at 13:00 (240 min past the 09:00 band end) — the bug.
    const ungated = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(13, 0),
    });
    expect(ungated.status).toBe("very_late");

    // WITH the server display-due (next slot tomorrow, not overdue) the
    // pill stays calm — the status can never read more overdue than the
    // next-due line.
    const gated = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(13, 0),
      nextDue: { at: dueTomorrow, overdue: false },
    });
    expect(gated.status).toBeNull();

    // Same at the late tier (10:00 — 60 min past the band end).
    const lateTier = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(10, 0),
      nextDue: { at: dueTomorrow, overdue: false },
    });
    expect(lateTier.status).toBeNull();
  });

  it("a genuinely open overdue slot keeps the band escalation", () => {
    const late = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(10, 0),
      nextDue: { at: dueToday, overdue: true },
    });
    expect(late.status).toBe("late");

    const veryLate = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(12, 30),
      nextDue: { at: dueToday, overdue: true },
    });
    expect(veryLate.status).toBe("very_late");
  });

  it("take-now shows only on the due day itself", () => {
    // In the 08:00–09:00 band but the next dose is tomorrow → calm.
    const notYetDue = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(8, 30),
      nextDue: { at: dueTomorrow, overdue: false },
    });
    expect(notYetDue.status).toBeNull();

    // Same wall clock, dose due today → the take-now pill renders.
    const dueNow = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(8, 30),
      nextDue: { at: dueToday, overdue: false },
    });
    expect(dueNow.status).toBe("in_window");
  });

  it("a null gate (no upcoming slot) suppresses the pill entirely", () => {
    const res = reduceCurrentWindowStatus({
      ...BASE,
      schedules: rolling,
      nowBerlin: localClock(8, 30),
      nextDue: null,
    });
    expect(res.status).toBeNull();
  });
});
