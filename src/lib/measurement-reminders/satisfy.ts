/**
 * v1.18.1 — the ONE shared satisfaction primitive for the Vorsorge /
 * measurement-reminder engine.
 *
 * Every path that marks a reminder's cadence fulfilled routes through
 * `satisfyReminder`: the manual "Erledigt" route, the cron auto-resolve,
 * and the eventful ingest-driven satisfaction worker. No duplicated
 * reschedule logic — one place stamps `lastSatisfiedAt` and recomputes the
 * server-authoritative `nextDueAt`.
 *
 * Two invariants the primitive owns:
 *
 *   1. **Forward-only.** `lastSatisfiedAt` only ever moves forward. A
 *      cron poll and an ingest enqueue can both fire for the same reading;
 *      the second is a no-op (returns `false`) rather than re-stamping an
 *      older instant. This is what makes the cron a safe idempotent
 *      safety-net behind the eventful hook.
 *   2. **Re-anchored reschedule.** `nextDueAt` is recomputed from the
 *      satisfy instant via the canonical recurrence engine
 *      (`computeReminderNextDueAt`), so a freshly-satisfied reminder rolls
 *      strictly past the current due cycle and the self-tracker never gets
 *      nagged.
 *
 * Pure-ish: it reads the row fields it is handed and issues one Prisma
 * update. The caller supplies the reminder row + the user's timezone.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "@/lib/measurement-reminders/scheduling";

/**
 * The reminder fields `satisfyReminder` needs. A subset of the Prisma row
 * so callers (and tests) can construct it without the full model.
 */
export interface SatisfiableReminder {
  id: string;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  lastSatisfiedAt: Date | null;
  createdAt: Date;
}

export interface SatisfyResult {
  /** True when the reminder was advanced; false when the event was older
   *  than (or equal to) the existing `lastSatisfiedAt` (forward-only
   *  no-op). */
  satisfied: boolean;
  /** The recomputed next-due instant when satisfied, else `null`. */
  nextDueAt: Date | null;
}

/**
 * Mark a reminder's cadence satisfied at `satisfiedAt` and reschedule.
 *
 * Forward-only: if `satisfiedAt` is not strictly after the existing
 * `lastSatisfiedAt`, nothing is written and `{ satisfied: false }` is
 * returned. Otherwise stamps `lastSatisfiedAt = satisfiedAt`, recomputes
 * `nextDueAt` from the satisfy instant, persists both, and returns
 * `{ satisfied: true, nextDueAt }`.
 */
export async function satisfyReminder(
  prisma: PrismaClient,
  reminder: SatisfiableReminder,
  timezone: string,
  satisfiedAt: Date,
): Promise<SatisfyResult> {
  // Forward-only guard. A null `lastSatisfiedAt` always advances. Equal
  // instants are a no-op so a cron poll behind an already-applied ingest
  // hook doesn't churn the row.
  if (
    reminder.lastSatisfiedAt !== null &&
    satisfiedAt.getTime() <= reminder.lastSatisfiedAt.getTime()
  ) {
    return { satisfied: false, nextDueAt: null };
  }

  const scheduleInput: ReminderScheduleInput = {
    intervalDays: reminder.intervalDays,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: satisfiedAt,
    createdAt: reminder.createdAt,
  };
  const nextDueAt = computeReminderNextDueAt(
    scheduleInput,
    timezone,
    satisfiedAt,
  );

  // v1.18.1 — close the forward-only TOCTOU: the in-memory guard above can
  // pass concurrently in the cron poll AND the eventful worker for the same
  // reading. Make the write itself conditional so exactly one wins. The
  // `updateMany` filter re-asserts the forward-only invariant against the
  // CURRENT row state; a racing writer that already advanced `lastSatisfiedAt`
  // to >= satisfiedAt yields `count === 0`, which we treat as a no-op rather
  // than re-stamping an older instant.
  const result = await prisma.measurementReminder.updateMany({
    where: {
      id: reminder.id,
      OR: [
        { lastSatisfiedAt: null },
        { lastSatisfiedAt: { lt: satisfiedAt } },
      ],
    },
    data: { lastSatisfiedAt: satisfiedAt, nextDueAt },
  });
  if (result.count === 0) {
    return { satisfied: false, nextDueAt: null };
  }

  return { satisfied: true, nextDueAt };
}
