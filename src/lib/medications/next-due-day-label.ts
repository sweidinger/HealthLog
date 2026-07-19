/**
 * Which day label the next-intake line carries — "today", "tomorrow", a
 * weekday name, or a full date.
 *
 * Lifted out of `<MedicationCard>` and `<MedicationTable>`, which carried
 * byte-identical copies of this arithmetic. Both surfaces must agree; two
 * copies is how they drift.
 *
 * The caller maps the result onto its own i18n strings, so this module
 * stays free of translation plumbing and is directly testable.
 */
import { localDayIndex, wallClockInTz } from "@/lib/tz/wall-clock";

export type NextDueDayLabel =
  | { kind: "today" }
  | { kind: "tomorrow" }
  /** 0 = Sunday … 6 = Saturday, read in the PROFILE zone. */
  | { kind: "weekday"; weekday: number }
  /**
   * Far enough out to want a full date. Carries the RAW instant — the
   * formatter applies the profile zone itself, so handing it a
   * zone-shifted `Date` would convert twice.
   */
  | { kind: "date"; instant: Date };

/**
 * Resolve the label for a next-due instant relative to `now`, both read in
 * `tz` (the user's PROFILE timezone — never the browser's).
 *
 * Two properties this function exists to guarantee:
 *
 *  - The distance is a CALENDAR-day difference, not an hour count. A
 *    `(next - now) / 86_400_000` round admits the 23 h / 25 h length of a
 *    DST-transition day and can round "tomorrow" into "today".
 *  - Every field is read through `wallClockInTz` in the profile zone, and
 *    the `date` case hands back the untouched instant. The previous
 *    implementation pre-shifted the instant into the profile zone and then
 *    passed that shifted value to a formatter that applies the zone AGAIN,
 *    so the rendered day was wrong for any user whose browser zone differs
 *    from their profile zone — invisible whenever the two agree.
 */
export function resolveNextDueDayLabel(
  nextAt: Date,
  now: Date,
  tz: string,
): NextDueDayLabel {
  const nextParts = wallClockInTz(nextAt, tz);
  const dayDelta =
    localDayIndex(nextParts) - localDayIndex(wallClockInTz(now, tz));

  if (dayDelta === 0) return { kind: "today" };
  if (dayDelta === 1) return { kind: "tomorrow" };
  if (dayDelta <= 5) return { kind: "weekday", weekday: nextParts.weekday };
  return { kind: "date", instant: nextAt };
}
