/**
 * Shared `HH:mm` → minutes-since-midnight helpers.
 *
 * Consolidates the copies that had accumulated across the medication
 * scheduling surfaces (the window validator, the dose-window geometry, the
 * per-medication schedule reconciler, the slot-instant resolver, the
 * recurrence engine, the cadence walker, and the worker helpers). Two
 * variants, matching the two behaviours those copies actually relied on:
 *
 *   - `hhmmToMinutes` assumes the literal was already regex-validated (the
 *     Zod window schema, a persisted schedule row) and does the arithmetic
 *     directly — a malformed literal yields `NaN`, which never reaches these
 *     callers;
 *   - `hhmmToMinutesOrNull` handles unvalidated input and returns `null` when
 *     the literal is not a well-formed numeric `HH:mm`, so a caller can decide
 *     the fallback (skip the time, treat as 0, …) explicitly.
 *
 * Pure string arithmetic, no imports — safe to pull into both server and
 * client bundles.
 */

/** Minutes-since-midnight for an already-validated `HH:mm` literal. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Minutes-since-midnight, or `null` when the literal is not a well-formed
 * numeric `HH:mm`. Use on any path that handles unvalidated schedule input.
 */
export function hhmmToMinutesOrNull(hhmm: string): number | null {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}
