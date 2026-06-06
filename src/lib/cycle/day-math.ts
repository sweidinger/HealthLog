/**
 * Shared day arithmetic for the cycle engine.
 *
 * This MUST match the iOS Swift re-implementation bit-for-bit. The whole point
 * of the cycle prediction engine is that the server (TypeScript) and the device
 * (Swift) compute byte-identical predictions from the same canonical inputs so
 * the offline calendar renders without a network round-trip and the materialised
 * server row matches the device's local recompute (a mismatch is a parity bug,
 * not last-write-wins).
 *
 * The load-bearing convention (algorithm.md §"Notation"):
 *   - Dates are `YYYY-MM-DD` strings (the MoodEntry / CycleDayLog convention).
 *   - A date is anchored at noon UTC (`T12:00:00Z`). Anchoring at noon — rather
 *     than midnight — keeps a whole-day difference exact across every timezone
 *     and DST transition (a ±1 h shift can never flip the rounded day count).
 *   - `dayDiff(a, b) = round((ms_a - ms_b) / 86_400_000)`.
 *   - NEVER diff with wall-clock / local time.
 *   - Rounding everywhere is round-half-UP to the stated precision:
 *     `Math.round(x * 10^k) / 10^k` in TS, mirrored by
 *     `(x * 10^k).rounded(.toNearestOrAwayFromZero) / 10^k` in Swift.
 */

/** Milliseconds in one calendar day. */
export const MS_PER_DAY = 86_400_000;

/** Strict `YYYY-MM-DD` shape guard. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` string into the epoch-ms of that date anchored at noon
 * UTC. Throws on a malformed string so a bad input fails closed rather than
 * silently producing `NaN` that would poison every downstream diff.
 */
export function parseDayMs(date: string): number {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`cycle/day-math: malformed date "${date}" (expected YYYY-MM-DD)`);
  }
  const ms = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`cycle/day-math: unparseable date "${date}"`);
  }
  return ms;
}

/**
 * Whole-day difference `a - b` (positive when `a` is later than `b`).
 * Rounds the ms quotient so a noon-UTC anchor makes the result DST-stable.
 */
export function dayDiff(a: string, b: string): number {
  return Math.round((parseDayMs(a) - parseDayMs(b)) / MS_PER_DAY);
}

/**
 * Return the `YYYY-MM-DD` string `n` days after `date` (`n` may be negative).
 * Computed off the noon-UTC anchor so it never crosses a day boundary by error.
 */
export function addDays(date: string, n: number): string {
  const ms = parseDayMs(date) + n * MS_PER_DAY;
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Round-half-up to `k` decimal places. `roundHalf(2.345, 2) === 2.35`,
 * `roundHalf(-2.345, 2) === -2.35` (away from zero on a tie), matching Swift's
 * `.toNearestOrAwayFromZero`. `k` defaults to 0 (integer rounding).
 */
export function roundHalf(x: number, k = 0): number {
  if (!Number.isFinite(x)) return x;
  const factor = 10 ** k;
  // Math.round is round-half-up toward +Infinity; mirror it away-from-zero for
  // negatives so the rule matches Swift's .toNearestOrAwayFromZero exactly.
  return x < 0 ? -Math.round(-x * factor) / factor : Math.round(x * factor) / factor;
}

/** `true` when `date` is on or before `other` (string compare is safe for ISO). */
export function isOnOrBefore(date: string, other: string): boolean {
  return dayDiff(date, other) <= 0;
}

/** `true` when `date` falls within the inclusive `[start, end]` span. */
export function isWithin(date: string, start: string, end: string): boolean {
  return dayDiff(date, start) >= 0 && dayDiff(end, date) >= 0;
}
