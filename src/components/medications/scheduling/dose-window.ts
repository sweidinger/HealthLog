/**
 * v1.15.18 — per-dose configurable on-time WINDOW helpers (the maintainer's
 * headline lever).
 *
 * A dose time can be expressed two ways:
 *   - a POINT (e.g. 19:00) → the engine's symmetric ±1h default band;
 *   - an explicit RANGE (e.g. 07:00–09:00) → persisted as a
 *     `{ timeOfDay, start, end }` entry on the schedule's `doseWindows`.
 *
 * These pure helpers translate between the persisted `DoseWindowEntry[]`
 * contract (validated by `doseWindowEntrySchema`) and the per-time view
 * model the `<DoseWindowEditor>` renders, and derive the displayed
 * on-time band + the cadence-aware late tail ("verspätet bis …"). They
 * are pure + framework-free so the window math is unit-tested without a
 * render.
 *
 * Defaults mirror `DOSE_WINDOW_DEFAULTS` so a POINT time reads identically
 * to the engine's no-override derivation:
 *   - intraday (daily / multi-daily): ±60 min on-time, +180 min late tail;
 *   - day-scale (weekly / rolling): ±1 day on-time, +4 days late tail.
 */

import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import { hhmmToMinutes } from "@/lib/medications/scheduling/hhmm";

// Re-exported so the existing `dose-window` consumers (and its unit suite)
// keep their import site while the implementation lives in the shared util.
export { hhmmToMinutes };

/** One persisted explicit window. Matches `doseWindowEntrySchema`. */
export interface DoseWindowEntry {
  timeOfDay: string;
  start: string;
  end: string;
}

/**
 * Window scale. `intraday` = a daily / multi-daily med (minute-scale
 * bands, the HH:mm range is the on-time window). `dayScale` = a weekly /
 * rolling injectable (the on-time window is whole-day; the explicit HH:mm
 * range still anchors the same wall-clock target but the late tail is
 * counted in days). The caller derives this from the schedule cadence.
 */
export type DoseWindowScale = "intraday" | "dayScale";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Wrap minutes-since-midnight back to HH:mm (clamps into the day, 24h wrap). */
export function minutesToHhmm(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** True when the literal is a well-formed HH:mm. */
export function isValidHhmm(value: string): boolean {
  return TIME_RE.test(value);
}

/**
 * The symmetric default on-time band around a POINT time (±1h for
 * intraday). Day-scale targets still surface the ±1h clock band as the
 * default range — the whole-day on-time tolerance is the engine's
 * concern; the editor only ever stores a wall-clock HH:mm range.
 */
export function defaultBandForTime(time: string): {
  start: string;
  end: string;
} {
  if (!isValidHhmm(time)) return { start: time, end: time };
  const half = DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes;
  const centre = hhmmToMinutes(time);
  return {
    start: minutesToHhmm(centre - half),
    end: minutesToHhmm(centre + half),
  };
}

/**
 * The late-tail end after the on-time window closes, scale-aware. For an
 * intraday med this is `end + dailyOverdueMinutes` (a wall-clock HH:mm); a
 * day-scale med returns `null` for the HH:mm (the tail is counted in days,
 * surfaced via {@link lateTailDays}).
 */
export function lateTailEndHhmm(
  end: string,
  scale: DoseWindowScale,
): string | null {
  if (scale === "dayScale") return null;
  if (!isValidHhmm(end)) return null;
  return minutesToHhmm(
    hhmmToMinutes(end) + DOSE_WINDOW_DEFAULTS.dailyOverdueMinutes,
  );
}

/** The late-tail length in days for a day-scale med (the 4-day rule). */
export function lateTailDays(): number {
  return DOSE_WINDOW_DEFAULTS.weeklyOverdueDays;
}

/**
 * An entry is an EXPLICIT range (not the default point band) when its
 * `[start, end]` differs from the symmetric ±1h band around `timeOfDay`.
 * A point-equivalent entry is dropped on serialise so the column stays
 * NULL-equivalent when the user touched nothing meaningful.
 */
export function isExplicitRange(entry: DoseWindowEntry): boolean {
  const def = defaultBandForTime(entry.timeOfDay);
  return entry.start !== def.start || entry.end !== def.end;
}

/** Index the persisted entries by `timeOfDay` for O(1) per-time lookup. */
export function entriesByTime(
  entries: DoseWindowEntry[] | undefined,
): Map<string, DoseWindowEntry> {
  const map = new Map<string, DoseWindowEntry>();
  for (const e of entries ?? []) map.set(e.timeOfDay, e);
  return map;
}

/**
 * Build the per-time view model the editor renders: for every dose time,
 * the explicit range when one is stored, else the default ±1h band, plus a
 * `custom` flag (a stored explicit range that differs from the default).
 */
export interface DoseWindowRow {
  timeOfDay: string;
  start: string;
  end: string;
  /** True when a stored explicit range differs from the default band. */
  custom: boolean;
}

export function buildRows(
  timesOfDay: string[],
  entries: DoseWindowEntry[] | undefined,
): DoseWindowRow[] {
  const byTime = entriesByTime(entries);
  return [...timesOfDay]
    .filter(isValidHhmm)
    .sort((a, b) => a.localeCompare(b))
    .map((timeOfDay) => {
      const stored = byTime.get(timeOfDay);
      if (stored && isExplicitRange(stored)) {
        return {
          timeOfDay,
          start: stored.start,
          end: stored.end,
          custom: true,
        };
      }
      const def = defaultBandForTime(timeOfDay);
      return { timeOfDay, start: def.start, end: def.end, custom: false };
    });
}

/**
 * Serialise the editor rows back to the persisted `DoseWindowEntry[]`.
 * Only rows the user marked `custom` and whose `[start, end]` actually
 * differs from the default band survive — a point-equivalent row is
 * dropped so the column stays minimal (and a med with no custom windows
 * serialises to `[]`, i.e. every slot keeps the default derivation).
 * Returns `null`-safe normalised entries; the caller decides whether `[]`
 * means "send empty array" or "omit".
 */
export function rowsToEntries(rows: DoseWindowRow[]): DoseWindowEntry[] {
  const out: DoseWindowEntry[] = [];
  for (const r of rows) {
    if (!r.custom) continue;
    if (!isValidHhmm(r.start) || !isValidHhmm(r.end)) continue;
    const entry: DoseWindowEntry = {
      timeOfDay: r.timeOfDay,
      start: r.start,
      end: r.end,
    };
    if (isExplicitRange(entry)) out.push(entry);
  }
  return out;
}

/** True when `start <= end` within the day (mirrors the server refine). */
export function isOrderedRange(start: string, end: string): boolean {
  if (!isValidHhmm(start) || !isValidHhmm(end)) return false;
  return hhmmToMinutes(start) <= hhmmToMinutes(end);
}
