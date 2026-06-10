/**
 * v1.15.20 — supply-runway estimate for the medication detail Übersicht.
 *
 * Pure helpers that turn the schedule snapshot the detail GET already
 * carries into an approximate doses-per-day figure, so the Übersicht tab
 * can render "lasts about N more days" from the inventory remaining-doses
 * count without a new endpoint. The estimate is deliberately coarse
 * (calendar months ≈ 30 days) — the copy says "about" and the Bestand tab
 * stays the authoritative per-item readout.
 */

import { parseScheduleRecurrence } from "@/lib/medication-schedule";

/** The schedule fields the runway estimate reads. */
export interface RunwaySchedule {
  windowStart: string;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
}

/**
 * Approximate doses per day across every schedule: times-of-day count,
 * scaled down by the cadence (rolling interval, weekly day picks +
 * interval weeks, monthly/yearly RRULEs).
 */
export function estimateDailyDoseCount(schedules: RunwaySchedule[]): number {
  let perDay = 0;
  for (const s of schedules) {
    const times =
      s.timesOfDay && s.timesOfDay.length > 0 ? s.timesOfDay.length : 1;
    if (
      typeof s.rollingIntervalDays === "number" &&
      s.rollingIntervalDays >= 1
    ) {
      perDay += times / s.rollingIntervalDays;
      continue;
    }
    const rrule = s.rrule ?? "";
    if (/FREQ=MONTHLY/.test(rrule)) {
      perDay += times / 30;
      continue;
    }
    if (/FREQ=YEARLY/.test(rrule)) {
      perDay += times / 365;
      continue;
    }
    const { daysOfWeek, intervalWeeks } = parseScheduleRecurrence(s.daysOfWeek);
    const daysPerWeek = daysOfWeek.length > 0 ? daysOfWeek.length : 7;
    const weeks = intervalWeeks >= 1 ? intervalWeeks : 1;
    perDay += (times * daysPerWeek) / (7 * weeks);
  }
  return perDay;
}

/**
 * Whole days the remaining supply covers, or `null` when no estimate is
 * possible (no supply, no consuming schedule).
 */
export function estimateRunwayDays(
  dosesRemaining: number,
  schedules: RunwaySchedule[],
): number | null {
  if (dosesRemaining <= 0) return null;
  const perDay = estimateDailyDoseCount(schedules);
  if (perDay <= 0) return null;
  return Math.floor(dosesRemaining / perDay);
}
