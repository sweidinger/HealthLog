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

export function deriveWheelState(
  days: CalendarDay[],
  today: string,
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

  // Walk back to the start of the current MENSTRUAL-anchored run: the first
  // day of the most recent MENSTRUAL block at/before today with no gap.
  let startIdx = todayIdx;
  for (let i = todayIdx; i >= 0; i--) {
    const d = sorted[i];
    if (d.phase == null) break;
    startIdx = i;
    if (d.phase === "MENSTRUAL" && (i === 0 || sorted[i - 1].phase !== "MENSTRUAL")) {
      break;
    }
  }

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
