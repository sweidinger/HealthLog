/**
 * v1.8.5 — `computeNextDueAt` tests, focused on the rolling-cadence
 * first-dose semantics.
 *
 * The server computes `nextDueAt` by asking the canonical engine for the
 * earliest next slot across a medication's schedules. The medically
 * important case: a rolling course whose `startsOn` is earlier today with
 * no intake logged must surface its start dose as DUE/OVERDUE ("take
 * now"), not roll it forward by N days (which also suppressed its
 * reminder, since the worker shares the engine).
 */
import { describe, expect, it } from "vitest";

import { computeNextDueAt } from "../next-due";
import type {
  WorkerMedicationRow,
  WorkerScheduleRow,
} from "../worker-helpers";

function d(iso: string): Date {
  return new Date(iso);
}

function makeMedication(
  overrides: Partial<WorkerMedicationRow> = {},
): WorkerMedicationRow {
  return {
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: d("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeRollingSchedule(
  overrides: Partial<WorkerScheduleRow> = {},
): WorkerScheduleRow {
  return {
    id: "sched-1",
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    timesOfDay: ["08:00"],
    reminderGraceMinutes: null,
    rrule: null,
    rollingIntervalDays: 7,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...overrides,
  };
}

const BERLIN = "Europe/Berlin";

function berlinDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BERLIN,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

describe("computeNextDueAt — rolling first dose", () => {
  it("surfaces an overdue first dose (past startsOn, no intake) as DUE today", () => {
    const startsOn = d("2026-06-10T06:00:00Z"); // 08:00 Berlin slot is past
    const now = d("2026-06-10T12:00:00Z"); // noon, after the slot
    const next = computeNextDueAt({
      medication: makeMedication({ startsOn }),
      schedules: [makeRollingSchedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeLessThan(now.getTime()); // overdue
    expect(berlinDay(next!)).toBe("2026-06-10");
  });

  it("returns the future first dose AT startsOn (no intake) without adding N", () => {
    const startsOn = d("2026-06-12T00:00:00Z");
    const now = d("2026-06-10T12:00:00Z");
    const next = computeNextDueAt({
      medication: makeMedication({ startsOn }),
      schedules: [makeRollingSchedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    expect(berlinDay(next!)).toBe("2026-06-12");
  });

  it("re-anchors on lastIntakeAt + N once an intake exists", () => {
    const now = d("2026-06-10T12:00:00Z");
    const next = computeNextDueAt({
      medication: makeMedication({ startsOn: d("2026-06-01T00:00:00Z") }),
      schedules: [makeRollingSchedule()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-09T08:00:00Z"),
    });
    expect(next).not.toBeNull();
    expect(berlinDay(next!)).toBe("2026-06-16"); // 2026-06-09 + 7d
  });

  it("returns null when no schedules", () => {
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [],
      now: d("2026-06-10T12:00:00Z"),
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).toBeNull();
  });
});

/**
 * v1.15.10 BUG 2 — next-due must advance past slots the user has already
 * resolved (taken / skipped / auto-missed) and surface the next genuinely
 * OPEN slot, not re-surface a present/past resolved slot ("träge").
 *
 * Twice-daily med, 07:00 + 19:00 Berlin. In June Berlin is UTC+2, so the
 * canonical slots are 05:00 UTC (07:00) and 17:00 UTC (19:00).
 */
describe("computeNextDueAt — skip resolved slots (twice-daily)", () => {
  function twiceDaily(): WorkerScheduleRow {
    return {
      id: "sched-2x",
      windowStart: "07:00",
      windowEnd: "19:00",
      daysOfWeek: null,
      timesOfDay: ["07:00", "19:00"],
      reminderGraceMinutes: null,
      rrule: null,
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
    };
  }

  it("advances to tomorrow's 07:00 when both of today's slots are resolved", () => {
    // Afternoon: 07:00 already past + logged, 19:00 logged early. Both today's
    // slots resolved → next must be tomorrow 07:00, not today 19:00.
    const now = d("2026-06-10T16:00:00Z"); // 18:00 Berlin, before the 19:00 slot
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [twiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-10T15:30:00Z"),
      resolvedSlots: [
        d("2026-06-10T05:00:00Z"), // today 07:00 Berlin
        d("2026-06-10T17:00:00Z"), // today 19:00 Berlin
      ],
    });
    expect(next).not.toBeNull();
    expect(berlinDay(next!)).toBe("2026-06-11");
    // 07:00 Berlin = 05:00 UTC.
    expect(next!.toISOString()).toBe("2026-06-11T05:00:00.000Z");
  });

  it("surfaces today's 19:00 when only the 07:00 slot is resolved", () => {
    const now = d("2026-06-10T16:00:00Z"); // 18:00 Berlin
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [twiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: d("2026-06-10T07:13:00Z"),
      resolvedSlots: [d("2026-06-10T05:00:00Z")], // only today 07:00
    });
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-06-10T17:00:00.000Z"); // today 19:00
  });

  it("keeps the legacy purely-time-anchored next-due when no resolvedSlots passed", () => {
    const now = d("2026-06-10T16:00:00Z"); // 18:00 Berlin → next slot is 19:00
    const next = computeNextDueAt({
      medication: makeMedication(),
      schedules: [twiceDaily()],
      now,
      userTz: BERLIN,
      lastIntakeAt: null,
    });
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe("2026-06-10T17:00:00.000Z"); // today 19:00
  });
});
