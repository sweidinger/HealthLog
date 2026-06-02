/**
 * Leaf timezone day-math + per-sample-row shape shared by the
 * consolidation drains.
 *
 * This module owns the primitives that both `consolidation-base.ts` (the
 * shared `runConsolidation` driver) and `drain-per-sample-cumulative.ts`
 * (the cumulative drain) need. It deliberately imports nothing from
 * either of those — it is a dependency-free leaf so the two can both
 * reach the helpers without forming an import cycle.
 *
 * History: `dayKeyForUserTz`, `canonicalDailyTimestamp`, `localStartOfDay`,
 * `localDayWindow`, the grace constant, and the `PerSampleRow` shape used
 * to live in `drain-per-sample-cumulative.ts`. `consolidation-base.ts`
 * imported them from there while `drain` imported the runner back — a
 * value-level cycle. Bundled for production (Turbopack merges tightly
 * cyclic modules into one body), the eager re-export
 * `const DRAIN_CUMULATIVE_CUTOFF_HOURS = CONSOLIDATION_GRACE_CUTOFF_HOURS`
 * was hoisted ahead of the constant it read, throwing a
 * `ReferenceError: Cannot access '…' before initialization` at worker
 * boot. Hoisting the shared leaf into this module removes the cycle at
 * its root; `drain-per-sample-cumulative.ts` re-exports these names so
 * every existing import site keeps working unchanged.
 */
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Canonical grace window shared by the cumulative + mean drains. Rows
 * whose `measuredAt` is newer than `now() - CONSOLIDATION_GRACE_CUTOFF_HOURS`
 * stay raw so today's still-in-flight watch syncs surface in the live
 * "today" view. 36 hours covers the previous calendar day plus a
 * trailing sync window for watches that weren't worn at midnight.
 */
export const CONSOLIDATION_GRACE_CUTOFF_HOURS = 36;

/**
 * Per-sample row shape the drains scan and bucket. Exposed for unit
 * testing the bucketing semantics without booting Prisma.
 */
export interface PerSampleRow {
  id: string;
  type: MeasurementType;
  value: number;
  measuredAt: Date;
  externalId: string | null;
  /**
   * Optional — only the mean-consolidation pass selects `unit` so it can
   * read the canonical unit straight off the day's rows rather than
   * issuing a separate query. The cumulative drain leaves it unselected.
   */
  unit?: string;
}

/**
 * Resolve the user's calendar-day key (`YYYY-MM-DD`) for a given
 * timestamp + timezone. Reuses the same `sv-SE` Intl formatting choice
 * the mood-entries path locked in v1.4.25 W7b so iOS-side and
 * server-side day-keys round-trip byte-identically.
 */
export function dayKeyForUserTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(date);
}

/**
 * Read the IANA-zone offset (in minutes east of UTC) at a given
 * instant. Returns 0 for UTC and any zone the shortOffset formatter
 * can't resolve (defensive — Node 22's full-icu build covers every
 * zone we care about).
 */
function tzOffsetMinutesAt(instant: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  });
  const parts = fmt.formatToParts(instant);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = match[3] ? Number.parseInt(match[3], 10) : 0;
  return sign * (hours * 60 + minutes);
}

/**
 * Compute the canonical timestamp for a calendar-day key in the user's
 * timezone. Returns the JS-Date instant at the user's local 12:00 noon
 * — matches the Withings activity sync convention (one daily row per
 * type, anchored to midday so the row sorts cleanly between same-day
 * spot samples). The string returned by `toISOString()` is UTC.
 */
export function canonicalDailyTimestamp(dateKey: string, tz: string): Date {
  // Compute the UTC offset for noon-local of the given day. We don't
  // have a lightweight TZ-math library on the server, so the trick is:
  // build "12:00 UTC of the day", read what wall-clock that shows in
  // the target zone, then shift by the resulting offset.
  const utcNoon = new Date(`${dateKey}T12:00:00.000Z`);
  const offsetMinutes = tzOffsetMinutesAt(utcNoon, tz);
  // utcNoon represents 12:00 UTC. The user's local clock reads
  // 12:00 + offsetMinutes at that instant. To anchor at local 12:00,
  // subtract the offset.
  return new Date(utcNoon.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * v1.4.37 W10 — Compute the JS-Date instant at the user's local 00:00
 * for a calendar-day key. Robust on DST transitions because the offset
 * is read at the UTC-midnight instant of the day, and EU/US DST
 * transitions happen at local 02:00 / 03:00 — so the offset at UTC
 * midnight is unambiguous on every day of the year.
 *
 * Used by the W7c drill-down branch to resolve [dayStart, dayEnd) on
 * a 23-h spring-forward or 25-h fall-back day; the previous shape
 * (`canonicalDailyTimestamp ± 12h`) silently leaked or hid an hour
 * of samples on two days per year.
 *
 * Pair with `localStartOfDay(nextDayKey, tz)` for the right bound so
 * the returned window covers the true local-day span — 23 h on
 * spring-forward, 24 h on a regular day, 25 h on fall-back.
 */
export function localStartOfDay(dateKey: string, tz: string): Date {
  // Anchor at 00:00 UTC of the day; the offset read at that instant
  // is the same offset the local clock uses at midnight (DST
  // transitions in EU/US happen at 02:00 / 03:00 local, not at the
  // 00:00 boundary). For sub-half-hour zones (Asia/Kathmandu UTC+5:45,
  // Pacific/Chatham UTC+12:45) the minute component is preserved.
  const utcMidnight = new Date(`${dateKey}T00:00:00.000Z`);
  const offsetMinutes = tzOffsetMinutesAt(utcMidnight, tz);
  // Local 00:00 at this date = UTC midnight - offset.
  return new Date(utcMidnight.getTime() - offsetMinutes * 60 * 1000);
}

/**
 * v1.4.37 W10 — Resolve the [dayStart, dayEnd) UTC window for a
 * calendar-day key in the user's IANA timezone. The window honours
 * DST so the drill-down branch returns the correct 23 / 24 / 25-hour
 * span for transition days.
 *
 * Returns a tuple where `dayEnd` is the local 00:00 of the FOLLOWING
 * calendar day — `< dayEnd` is the canonical half-open bound used by
 * the route's `measuredAt: { gte: dayStart, lt: dayEnd }` predicate.
 */
export function localDayWindow(
  dateKey: string,
  tz: string,
): { dayStart: Date; dayEnd: Date } {
  const dayStart = localStartOfDay(dateKey, tz);
  // Add ONE day to dateKey using UTC arithmetic on a noon anchor (noon
  // sidesteps every DST edge case for the calendar increment). Then
  // re-extract the ISO date slice — guaranteed to be the next-day key.
  const nextUtcNoon = new Date(`${dateKey}T12:00:00.000Z`);
  nextUtcNoon.setUTCDate(nextUtcNoon.getUTCDate() + 1);
  const nextDateKey = nextUtcNoon.toISOString().slice(0, 10);
  const dayEnd = localStartOfDay(nextDateKey, tz);
  return { dayStart, dayEnd };
}
