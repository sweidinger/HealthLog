/**
 * v1.7.0 SB-SCHED-3 — server-computed `nextDueAt`.
 *
 * Stops the iOS client re-implementing the recurrence engine: the
 * server computes the next due instant per medication by asking the
 * canonical engine (`nextOccurrenceAfter`) for each schedule and taking
 * the earliest. Pure / synchronous — the caller fetches `lastIntakeAt`
 * (rolling cadences re-anchor on it) and the user timezone.
 *
 * Returns null when no schedule has an upcoming slot (paused course,
 * one-shot already in the past, `endsOn` crossed, every schedule PRN).
 */
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerMedicationRow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { nextOccurrenceAfter } from "@/lib/medications/scheduling/recurrence";

/**
 * v1.15.10 — radius an intake may sit from a slot's canonical instant and
 * still count as resolving it. Intake writes snap `scheduledFor` to the exact
 * engine slot instant, so the match is normally exact; the ±6h tolerance is
 * the same defensive half-gap the compliance open-dose search uses (a 12h-gap
 * twice-daily med splits cleanly at ±6h).
 */
const RESOLVE_RADIUS_MS = 6 * 60 * 60 * 1000;

export function computeNextDueAt(input: {
  medication: WorkerMedicationRow;
  schedules: WorkerScheduleRow[];
  now: Date;
  userTz: string;
  lastIntakeAt: Date | null;
  /**
   * v1.15.10 — slot instants the user has already acted on (taken / skipped /
   * auto-missed). The next-due search skips any occurrence that matches one of
   * these so a twice-daily med whose remaining slots today are all logged
   * advances to the next genuinely-open slot (tomorrow's first dose) instead
   * of re-surfacing a resolved present/past slot. Omit for the legacy
   * purely-time-anchored next-due.
   */
  resolvedSlots?: Date[];
}): Date | null {
  const { medication, schedules, now, userTz, lastIntakeAt } = input;
  if (schedules.length === 0) return null;

  const resolved = input.resolvedSlots ?? [];
  const isResolved = (slotAt: Date): boolean => {
    const slot = slotAt.getTime();
    for (const r of resolved) {
      if (Math.abs(r.getTime() - slot) <= RESOLVE_RADIUS_MS) return true;
    }
    return false;
  };

  const ctx = buildRecurrenceContext({ medication, userTz, lastIntakeAt });
  let earliest: Date | null = null;
  for (const schedule of schedules) {
    const canonical = buildCanonicalSchedule(schedule);
    // Walk forward past slots the user has already resolved. Bounded so a
    // fully-logged-ahead history can't spin.
    let after = now;
    for (let step = 0; step < 64; step++) {
      const next = nextOccurrenceAfter(canonical, after, ctx);
      if (next === null) break;
      if (!isResolved(next.at)) {
        if (earliest === null || next.at.getTime() < earliest.getTime()) {
          earliest = next.at;
        }
        break;
      }
      after = new Date(next.at.getTime());
    }
  }
  return earliest;
}
