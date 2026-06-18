/**
 * Local-calendar-day helpers built on `wallClockInTz`.
 *
 * Merged in from the former `src/lib/timezone.ts` so every
 * Intl-backed timezone primitive lives under `src/lib/tz/`. The
 * wall-clock decomposition itself is `wallClockInTz` (see
 * `./wall-clock`); the helpers here derive UTC instants from the
 * user's local calendar day — today's bounds for database queries,
 * the local weekday, and the UTC instant of a local `hh:mm`.
 */
import { wallClockInTz } from "./wall-clock";

/**
 * Get the start (midnight) and end (23:59:59.999) of "today" in the user's
 * timezone, returned as UTC Date objects suitable for database queries.
 */
export function getUserTodayBounds(
  now: Date,
  tz: string,
): { start: Date; end: Date } {
  const parts = wallClockInTz(now, tz);

  // Build a UTC date that represents the user's local midnight
  // by computing the offset between the real UTC time and the local
  // representation.
  const localMidnightAsUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0),
  );

  // Compute offset: how far ahead (positive) or behind (negative) the tz is
  // from UTC. localMidnightAsUtc represents "midnight in tz as if it were
  // UTC"; we need the UTC instant that corresponds to midnight in the tz.
  const localNowAsUtc = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  const offsetMs =
    Math.round((localNowAsUtc.getTime() - now.getTime()) / 60000) * 60000;

  const start = new Date(localMidnightAsUtc.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { start, end };
}

/**
 * UTC instant of local midnight (00:00 wall-clock) on the calendar day
 * `instant` falls on in `tz`. DST-safe: derives the zone offset at the
 * target local time so the returned instant always represents the user's
 * local start-of-day, never UTC midnight of that calendar date.
 *
 * Canonical start-of-local-day primitive. The medication-scheduling
 * `startOfLocalDay` (cadence) and `startOfDayInTz` (recurrence) route
 * through this so the day-floor never drifts between surfaces. When `tz`
 * is omitted the host's system-local day is used.
 */
export function startOfLocalDayInTz(
  instant: Date,
  tz: string | undefined,
): Date {
  if (!tz) {
    return new Date(
      instant.getFullYear(),
      instant.getMonth(),
      instant.getDate(),
      0,
      0,
      0,
      0,
    );
  }
  const parts = wallClockInTz(instant, tz);
  // Two-pass converge: treat the wall clock as UTC, then correct by the
  // zone offset at that approximate instant. The second pass settles the
  // offset across a DST transition for every IANA zone.
  let guess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0),
  );
  for (let i = 0; i < 2; i++) {
    const at = wallClockInTz(guess, tz);
    const asIfUtc = Date.UTC(
      at.year,
      at.month - 1,
      at.day,
      at.hour,
      at.minute,
      at.second,
    );
    const offsetMin = Math.round((asIfUtc - guess.getTime()) / 60_000);
    guess = new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0) -
        offsetMin * 60_000,
    );
  }
  return guess;
}

/**
 * Get the day of the week (0=Sun..6=Sat) for a given instant in a specific
 * timezone.
 */
export function getDayOfWeekInTz(now: Date, tz: string): number {
  return wallClockInTz(now, tz).weekday;
}

/**
 * Compute the UTC instant of local `hh:mm` on the local calendar day
 * implied by `now` in `tz`. DST-safe — `todayStart.getTime() + h * 3.6e6`
 * drifts by an hour on spring-forward / fall-back days because raw UTC
 * arithmetic ignores the DST jump between local midnight and local
 * `hh:mm`. This helper re-derives the offset at the target local time
 * so the returned instant always represents local `hh:mm`.
 */
export function localHmAsUtc(
  now: Date,
  tz: string,
  hour: number,
  minute: number,
): Date {
  const parts = wallClockInTz(now, tz);
  const localAtTargetAsUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0),
  );
  const localNowAsUtc = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  const offsetMs =
    Math.round((localNowAsUtc.getTime() - now.getTime()) / 60000) * 60000;
  return new Date(localAtTargetAsUtc.getTime() - offsetMs);
}
