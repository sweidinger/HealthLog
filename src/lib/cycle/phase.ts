/**
 * Phase assignment — pure, per calendar date, both engines identical.
 *
 * Implements algorithm.md §"Phase channel". Given a cycle [start, nextStart)
 * with length L and an ovulation day (confirmed or estimated as
 * start + (L − lutealLength)):
 *
 *   - MENSTRUAL  = [start, start + P̂ − 1]
 *   - OVULATORY  = [ovulationDay − 1, ovulationDay + 1]   (3-day window)
 *   - FOLLICULAR = (end of menstrual, ovulatory start)    day after period → ovulatory
 *   - LUTEAL     = (ovulatory end, nextStart)             after ovulatory → day before next start
 *
 * Precedence on overlap: MENSTRUAL > OVULATORY > FOLLICULAR/LUTEAL (a day is
 * menstrual if bleeding even when the calendar window says otherwise).
 *
 * This MUST match the calendar route, the CYCLE_PHASE correlation channel, and
 * what iOS computes offline.
 */

import { addDays, dayDiff } from "./day-math";
import { clampLuteal } from "./prediction";
import { LUTEAL_DEFAULT, POPULATION_DEFAULT_PERIOD, type CyclePhase } from "./types";

/** A resolved cycle window the phase mapper needs. */
export interface PhaseCycle {
  /** First bleeding day, `YYYY-MM-DD`. */
  startDate: string;
  /** First day of the NEXT cycle, `YYYY-MM-DD`. The cycle is [start, nextStart). */
  nextStart: string;
  /** Ovulation day (confirmed or estimated). Null → estimate from length/luteal. */
  ovulationDate: string | null;
  /** Period (bleeding) length in days. Null → POPULATION_DEFAULT_PERIOD. */
  periodLength: number | null;
  /** Luteal length used to estimate ovulation when ovulationDate is null. */
  lutealLength?: number;
}

/**
 * Map a single date to its phase within the supplied cycle, plus the 1-based
 * day-of-cycle. Returns `{ phase: null, dayOfCycle: null }` when the date is
 * outside `[startDate, nextStart)`.
 */
export function phaseForDay(
  date: string,
  cycle: PhaseCycle,
): { phase: CyclePhase | null; dayOfCycle: number | null } {
  const offsetFromStart = dayDiff(date, cycle.startDate);
  const cycleLength = dayDiff(cycle.nextStart, cycle.startDate);

  // Outside [start, nextStart): not part of this cycle.
  if (offsetFromStart < 0 || offsetFromStart >= cycleLength) {
    return { phase: null, dayOfCycle: null };
  }

  const dayOfCycle = offsetFromStart + 1; // 1-based

  const periodLength = cycle.periodLength ?? POPULATION_DEFAULT_PERIOD;
  // Clamp identically to the prediction engine (QA HIGH: one source of truth).
  const lutealLength = clampLuteal(cycle.lutealLength ?? LUTEAL_DEFAULT);

  // Ovulation: confirmed/estimated date, or back-calculated from length.
  const ovulationDate =
    cycle.ovulationDate ?? addDays(cycle.startDate, cycleLength - lutealLength);

  // Boundary days (inclusive offsets from start).
  const menstrualEnd = periodLength - 1; // [0, P-1]
  const ovulationOffset = dayDiff(ovulationDate, cycle.startDate);
  const ovulatoryStart = ovulationOffset - 1; // [ov-1, ov+1]
  const ovulatoryEnd = ovulationOffset + 1;

  // Precedence: MENSTRUAL first (bleeding wins).
  if (offsetFromStart <= menstrualEnd) {
    return { phase: "MENSTRUAL", dayOfCycle };
  }
  // OVULATORY next.
  if (offsetFromStart >= ovulatoryStart && offsetFromStart <= ovulatoryEnd) {
    return { phase: "OVULATORY", dayOfCycle };
  }
  // FOLLICULAR = after menstrual, before the ovulatory window.
  if (offsetFromStart < ovulatoryStart) {
    return { phase: "FOLLICULAR", dayOfCycle };
  }
  // LUTEAL = after the ovulatory window, to the day before nextStart.
  return { phase: "LUTEAL", dayOfCycle };
}

/**
 * Convenience: produce the daily phase series across `[from, to]` inclusive for
 * a single cycle. Days outside the cycle window carry `phase: null`. This is the
 * shape the CYCLE_PHASE behaviour channel consumes (one categorical value/day).
 */
export function phaseSeries(
  from: string,
  to: string,
  cycle: PhaseCycle,
): { date: string; phase: CyclePhase | null; dayOfCycle: number | null }[] {
  const span = dayDiff(to, from);
  const out: { date: string; phase: CyclePhase | null; dayOfCycle: number | null }[] = [];
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    out.push({ date, ...phaseForDay(date, cycle) });
  }
  return out;
}
