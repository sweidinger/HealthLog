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
