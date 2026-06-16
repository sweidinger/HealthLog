/**
 * v1.17.1 — server-authoritative next-due computation for Vorsorge
 * (measurement) reminders.
 *
 * Reuses the canonical medication recurrence engine
 * (`src/lib/medications/scheduling/recurrence.ts`) so a Vorsorge cadence
 * is driven by exactly the same code that powers the medication
 * "nextDueAt" line — web ↔ iOS read identical numbers (server-authoritative
 * per project memory: iOS consumes the resolved DTO, never recomputes).
 *
 * A `MeasurementReminder` maps onto the engine's `CanonicalSchedule` +
 * `RecurrenceContext` as follows:
 *
 *   - rolling `intervalDays`  → `rollingIntervalDays`, anchored on
 *     `lastSatisfiedAt ?? anchorDate ?? createdAt`. With no satisfy yet
 *     the first due is AT the anchor (not anchor + N); once satisfied the
 *     `+ N` cadence begins, exactly like a rolling medication's
 *     last-intake anchor.
 *   - `rrule`                 → passed straight through (RFC-5545).
 *   - the single `notifyHour` → the schedule's one `timesOfDay` entry, so
 *     the slot fires at the user's chosen local hour (DST-safe — the
 *     engine applies the time in the user's IANA timezone).
 *
 * Pure: no DB access. The caller fetches the reminder row + the user's
 * timezone and threads them in.
 */
import {
  type CanonicalSchedule,
  type RecurrenceContext,
  nextOccurrenceAfter,
} from "@/lib/medications/scheduling/recurrence";

/**
 * The reminder fields this module reads. A subset of the Prisma row so
 * tests can construct it without the full model.
 */
export interface ReminderScheduleInput {
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  lastSatisfiedAt: Date | null;
  createdAt: Date;
  /**
   * v1.18.1 (Workstream C) — optional course-window end. NULL ⇒ open-ended
   * (the existing behaviour). Non-NULL bounds a finite cadence: the
   * recurrence engine stops producing occurrences past this instant, so a
   * Coach-suggested time-boxed protocol (ESH/AHA 7-day BP) self-expires.
   */
  endsOn?: Date | null;
}

function hourToHhmm(hour: number): string {
  const safe = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
  return `${safe.toString().padStart(2, "0")}:00`;
}

/**
 * Build the `(CanonicalSchedule, RecurrenceContext)` pair the engine
 * consumes for one Vorsorge reminder.
 *
 * The rolling anchor is threaded through the engine's `lastIntakeAt`
 * (after a satisfy) and `medication.startsOn` (the first-due anchor when
 * never satisfied) so the rolling path's "first dose AT the anchor, then
 * + N after the first satisfy" semantics apply verbatim.
 */
export function buildReminderRecurrence(
  reminder: ReminderScheduleInput,
  timeZone: string,
): { schedule: CanonicalSchedule; ctx: RecurrenceContext } {
  const hhmm = hourToHhmm(reminder.notifyHour);

  const schedule: CanonicalSchedule = {
    id: "measurement-reminder",
    rrule: reminder.rrule,
    rollingIntervalDays: reminder.intervalDays,
    timesOfDay: [hhmm],
    daysOfWeek: null,
    windowStart: hhmm,
    windowEnd: hhmm,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };

  // First-due anchor when never satisfied: anchorDate ?? createdAt. After
  // a satisfy the rolling path re-anchors on `lastIntakeAt + N`, so we
  // feed `lastSatisfiedAt` through `lastIntakeAt`.
  const startsOn = reminder.anchorDate ?? reminder.createdAt;

  const ctx: RecurrenceContext = {
    medication: {
      id: "measurement-reminder",
      startsOn,
      endsOn: reminder.endsOn ?? null,
      oneShot: false,
      createdAt: reminder.createdAt,
    },
    timeZone: timeZone || "Europe/Berlin",
    lastIntakeAt: reminder.lastSatisfiedAt,
  };

  return { schedule, ctx };
}

/**
 * Compute the canonical next-due instant for a reminder, strictly after
 * `after`. Returns `null` when the cadence is uncomputable (no interval +
 * no rrule) or the engine finds no future occurrence.
 *
 * `after` defaults to `now` but the caller can floor it (e.g. to the last
 * satisfy instant) so a freshly-satisfied reminder advances past the
 * current due cycle.
 */
export function computeReminderNextDueAt(
  reminder: ReminderScheduleInput,
  timeZone: string,
  after: Date,
): Date | null {
  if (reminder.intervalDays === null && reminder.rrule === null) {
    return null;
  }
  const { schedule, ctx } = buildReminderRecurrence(reminder, timeZone);
  const occurrence = nextOccurrenceAfter(schedule, after, ctx);
  return occurrence?.at ?? null;
}
