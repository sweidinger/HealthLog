/**
 * v1.4.22 W5 reconcile (Code-MED-1) — shared Berlin-day-key helper.
 *
 * The CLAUDE.md timezone convention is "Europe/Berlin for display,
 * UTC in database". The dashboard analytics route used a private
 * `berlinDayKey()` (defined in `src/app/api/analytics/route.ts:330`)
 * to bucket measurements by Berlin calendar day. The targets route's
 * `sparklinePoints()` was bucketing by UTC `YYYY-MM-DD` — a 23:30
 * Berlin reading on Tuesday landed in Wednesday's bucket, drifting
 * the sparkline 1 day on cross-DST boundaries.
 *
 * Lift the helper into `src/lib/analytics/` so every display surface
 * shares the same bucket contract.
 */

const BERLIN_DATE_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Format a `Date` as a `YYYY-MM-DD` string anchored to Europe/Berlin
 * calendar day. Used as a stable key for daily aggregation so a
 * 23:30-Berlin reading on Tuesday lands in Tuesday's bucket
 * regardless of UTC offset (CET / CEST, DST).
 */
export function berlinDayKey(d: Date): string {
  const parts = BERLIN_DATE_PARTS.formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}
