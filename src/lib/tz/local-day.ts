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
 *
 * DST-safe. Both bounds route through {@link startOfLocalDayInTz}, whose
 * two-pass solver settles the zone offset AT the target local midnight —
 * not at `now`. The window therefore spans the user's real local day even
 * when it is 23 h (spring-forward) or 25 h (fall-back): the previous
 * implementation sampled the offset at `now` and hardcoded a 24 h length,
 * so on a fall-back day the last local hour (e.g. a 23:30 dose) fell
 * OUTSIDE `[midnight, midnight+24h)` and on a spring-forward day the window
 * bled one hour into the next local day.
 */
export function getUserTodayBounds(
  now: Date,
  tz: string,
): { start: Date; end: Date } {
  const start = startOfLocalDayInTz(now, tz);
  // Start of the NEXT local day. Advancing 25 h always crosses into the next
  // calendar day (a real day is 23–25 h, never ≤ 12.5 h, so 25 h can neither
  // fall short of the next day nor skip past it), then floor back to that
  // day's local midnight. `end` is the inclusive last millisecond of today.
  const nextDayStart = startOfLocalDayInTz(
    new Date(start.getTime() + 25 * 60 * 60 * 1000),
    tz,
  );
  const end = new Date(nextDayStart.getTime() - 1);

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
