/**
 * v1.15.0 — derive the cycle-wheel state (day-of-cycle, current phase,
 * proportional phase spans) from the calendar read.
 *
 * The calendar read already labels each day with its `phase`; we walk
 * backward from today to the start of the current run of consecutive
 * non-null phase days to find the cycle's start, count the day-of-cycle, and
 * tally each phase's share of that run for the proportional ring segments.
 * Pure + deterministic so it matches the server engine's labels 1:1.
 */
import type { CalendarDay, CyclePhase } from "./types";

const PHASE_ORDER: CyclePhase[] = [
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
];

export interface WheelState {
  dayOfCycle: number | null;
  cycleLength: number | null;
  phase: CyclePhase | null;
  spans: { phase: CyclePhase; fraction: number }[];
}

/**
 * The profile-derived canonical phase lengths used to draw an idealized ring
 * for a low-data tracker (see `idealizedSpans`). All optional — every field
 * falls back to the textbook default when the profile has not set it.
 */
export interface CycleProfileLengths {
  /** Typical full cycle length in days (default 28). */
  typicalCycleLength?: number | null;
  /** Typical period (menstrual) length in days (default 5). */
  typicalPeriodLength?: number | null;
  /** Typical luteal-phase length in days (default 14). */
  lutealPhaseLength?: number | null;
}

/** Below this many labelled days in the current cycle run, the ring would
 * normalise a 1-3 day partial run so a single phase filled the whole circle.
 * For such low-data trackers we draw the canonical four-phase proportions from
 * the profile instead, so the dial always reads as a real cycle wheel. A run
 * of 7+ labelled days already spans more than the menstrual phase, so the
 * observed-share path takes over from there. */
const SPARSE_RUN_THRESHOLD = 7;

/**
 * The canonical four-phase span set for a low-data tracker, derived from the
 * profile's typical lengths (textbook defaults when unset): a 28-day cycle
 * with a 5-day period, a 2-day ovulatory window, a 14-day luteal phase, and
 * the follicular phase filling the remainder. Proportions, not day counts, so
 * the ring renders the familiar MENSTRUAL/FOLLICULAR/OVULATORY/LUTEAL arcs
 * instead of one dominant sliver.
 */
function idealizedSpans(profile?: CycleProfileLengths): {
  spans: { phase: CyclePhase; fraction: number }[];
  cycleLength: number;
} {
  const cycle = Math.max(
    Math.round(profile?.typicalCycleLength ?? 28) || 28,
    7,
  );
  const period = Math.min(
    Math.max(Math.round(profile?.typicalPeriodLength ?? 5) || 5, 1),
    cycle - 3,
  );
  const luteal = Math.min(
    Math.max(Math.round(profile?.lutealPhaseLength ?? 14) || 14, 1),
    cycle - period - 1,
  );
  // A short ovulatory window sits at the fertile peak; the follicular phase
  // fills whatever remains between the period and the ovulatory window.
  const ovulatory = Math.min(2, Math.max(cycle - period - luteal - 1, 1));
  const follicular = Math.max(cycle - period - ovulatory - luteal, 1);

  const days: Record<CyclePhase, number> = {
    MENSTRUAL: period,
    FOLLICULAR: follicular,
    OVULATORY: ovulatory,
    LUTEAL: luteal,
  };
  const total = days.MENSTRUAL + days.FOLLICULAR + days.OVULATORY + days.LUTEAL;
  const spans = PHASE_ORDER.map((phase) => ({
    phase,
    fraction: days[phase] / total,
  }));
  return { spans, cycleLength: total };
}

/**
 * Walk back from `todayIdx` to the start of the current MENSTRUAL-anchored run:
 * the first day of the most recent MENSTRUAL block at/before today with no phase
 * gap. The ONE source of truth both `currentCycleStartDate` and
 * `deriveWheelState` use, so the BBT chart, the day-of-cycle count, and the ring
 * spans can never disagree on where the current cycle begins. Assumes
 * `sorted[todayIdx].phase != null` (the callers check first).
 */
function findCycleStartIndex(sorted: CalendarDay[], todayIdx: number): number {
  let startIdx = todayIdx;
  for (let i = todayIdx; i >= 0; i--) {
    const d = sorted[i];
    if (d.phase == null) break;
    startIdx = i;
    if (
      d.phase === "MENSTRUAL" &&
      (i === 0 || sorted[i - 1].phase !== "MENSTRUAL")
    ) {
      break;
    }
  }
  return startIdx;
}

/**
 * The first day (`YYYY-MM-DD`) of the current cycle, or null when today has no
 * phase (no active cycle). Scopes the BBT chart to the same cycle the wheel
 * shows.
 */
export function currentCycleStartDate(
  days: CalendarDay[],
  today: string,
): string | null {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const todayIdx = sorted.findIndex((d) => d.date === today);
  if (todayIdx < 0 || sorted[todayIdx].phase == null) return null;
  return sorted[findCycleStartIndex(sorted, todayIdx)].date;
}

export function deriveWheelState(
  days: CalendarDay[],
  today: string,
  profile?: CycleProfileLengths,
): WheelState {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const todayDay = byDate.get(today);
  if (!todayDay || todayDay.phase == null) {
    return { dayOfCycle: null, cycleLength: null, phase: null, spans: [] };
  }

  // Sort dates ascending and find today's index.
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const todayIdx = sorted.findIndex((d) => d.date === today);
  if (todayIdx < 0) {
    return { dayOfCycle: null, cycleLength: null, phase: null, spans: [] };
  }

  const startIdx = findCycleStartIndex(sorted, todayIdx);
  const run = sorted.slice(startIdx, todayIdx + 1);
  const dayOfCycle = run.length;

  // Tally each phase's day-count across the run + the forward predicted run
  // (so the ring shows the whole cycle, not just elapsed days).
  const counts: Record<CyclePhase, number> = {
    MENSTRUAL: 0,
    FOLLICULAR: 0,
    OVULATORY: 0,
    LUTEAL: 0,
  };
  // Include forward days until the next MENSTRUAL block to bound a full cycle.
  let end = todayIdx;
  for (let i = todayIdx + 1; i < sorted.length; i++) {
    const d = sorted[i];
    if (d.phase == null) break;
    if (d.phase === "MENSTRUAL") break;
    end = i;
  }
  const fullRun = sorted.slice(startIdx, end + 1);
  for (const d of fullRun) {
    if (d.phase) counts[d.phase] += 1;
  }

  // Low-data tracker: too few labelled days to span a real cycle. The
  // observed-share math would normalise a 1-3 day partial run so a single
  // phase filled the whole ring (the "one dominant arc" bug). Fall back to the
  // canonical four-phase proportions derived from the profile's typical
  // lengths so the dial reads as a real cycle wheel. The current phase + the
  // day-of-cycle marker stay driven by the observed labels; only the arc
  // proportions and the ring's represented length come from the ideal.
  if (fullRun.length < SPARSE_RUN_THRESHOLD) {
    const ideal = idealizedSpans(profile);
    return {
      dayOfCycle,
      cycleLength: ideal.cycleLength,
      phase: todayDay.phase,
      spans: ideal.spans,
    };
  }

  const total = fullRun.length || 1;
  const spans = PHASE_ORDER.filter((p) => counts[p] > 0).map((phase) => ({
    phase,
    fraction: counts[phase] / total,
  }));

  return {
    dayOfCycle,
    cycleLength: fullRun.length,
    phase: todayDay.phase,
    spans,
  };
}
