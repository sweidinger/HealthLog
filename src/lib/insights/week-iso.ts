/**
 * v1.4.20 phase B4 — ISO-week helpers shared between the weekly-report
 * route, the AI schema, and the hero strip's banner card.
 *
 * Format: `YYYY-Www` where ww is the two-digit ISO week number
 * (01-53). ISO 8601 weeks start on Monday and Week 1 is the week
 * containing the first Thursday of the calendar year.
 */

const WEEK_ISO_PATTERN = /^(\d{4})-W(\d{2})$/;

export interface ParsedWeekISO {
  /** Original normalised string ("YYYY-Www"). */
  weekISO: string;
  /** Numeric ISO year (the year of the week's Thursday). */
  year: number;
  /** Numeric ISO week (1-53). */
  week: number;
}

/**
 * Parse a `YYYY-Www` string into its numeric pieces. Returns `null`
 * when the input is malformed, the year is out of range, or the week
 * number is not in 1..53. The route uses this guard to 404 instead
 * of rendering a half-broken report.
 */
export function parseWeekISO(input: string): ParsedWeekISO | null {
  const match = WEEK_ISO_PATTERN.exec(input);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isFinite(year) || year < 1900 || year > 2999) return null;
  if (!Number.isFinite(week) || week < 1 || week > 53) return null;
  return { weekISO: input, year, week };
}

/**
 * Compute the ISO-week identifier for a given date. Mirrors the
 * algorithm used by `bucketTimeSeries` so a Berlin-calendar Monday
 * lands in the correct week.
 */
export function toWeekISO(date: Date): string {
  // Copy to UTC at midnight so DST shifts don't bump us across a day.
  const utc = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  // ISO weekday with Monday=1..Sunday=7.
  const dow = ((utc.getUTCDay() + 6) % 7) + 1;
  // Move to the Thursday of this week (ISO week number = week of that
  // Thursday's calendar year).
  utc.setUTCDate(utc.getUTCDate() - dow + 4);
  const isoYear = utc.getUTCFullYear();
  // Find the first Thursday of the ISO year.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = ((jan4.getUTCDay() + 6) % 7) + 1;
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() + (4 - jan4Dow));
  const week = Math.round(
    (utc.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000) + 1,
  );
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Inverse of `toWeekISO` — return the Monday + Sunday (UTC midnights)
 * that bound the given ISO-week identifier. Returns `null` for
 * malformed input. Used by the report header to print the "May 4 to
 * May 10" date range below the title.
 */
export function weekISOToRange(
  input: string,
): { start: Date; end: Date } | null {
  const parsed = parseWeekISO(input);
  if (!parsed) return null;
  const { year, week } = parsed;
  // Jan 4 is always in ISO week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = ((jan4.getUTCDay() + 6) % 7) + 1;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const start = new Date(week1Monday);
  start.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}
