/**
 * Issue #490 — axis/tooltip label formatters for CALENDAR-DAY-ENCODED chart
 * timestamps.
 *
 * Every timestamp the health/mood chart data pipeline hands to its label
 * formatters encodes a calendar day, not an instant:
 *
 *   - day-granularity rows carry `Date.UTC(y, m-1, d, 12)` (noon UTC) of a
 *     profile-timezone day key (`dayKeyToTimestamp` in both charts);
 *   - week/month buckets from `bucketTimeSeries` carry
 *     `Date.UTC(y, m-1, d)` (UTC midnight) of the Berlin calendar day the
 *     bucket starts on (ISO-week Monday / month 1st).
 *
 * Formatting those encodings through a PROFILE-timezone formatter re-reads
 * the encoded day in a different zone: a Berlin `Jul 1` month bucket
 * renders as "Jun 30" for every profile west of Berlin (month/weekday axis
 * labels slide), and a noon-UTC day key slips a day for profiles at
 * UTC+13. The label is fully determined by the encoded calendar day, so it
 * renders UTC-pinned — byte-identical for Berlin profiles (UTC midnight /
 * noon stay on the same Berlin day) and correct for every other zone.
 *
 * The bucket MATH in `bucket-time-series.ts` is deliberately untouched
 * (DSTMIG-scarred); this is the label-side half of the contract.
 */

import { makeFormatters, type Formatters } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";

export function makeBucketLabelFormatters(locale: Locale): Formatters {
  return makeFormatters(locale, "UTC");
}
