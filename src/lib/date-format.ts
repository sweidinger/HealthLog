/**
 * Client-side mirror of the per-user date-order preference, plus the
 * display helpers the `<DateField>` primitive renders through.
 *
 * The server-authoritative value lives on the user row (`users.date_format`,
 * surfaced by `/api/auth/me` and editable via the profile PATCH). The mirror
 * follows the `time-format.ts` pattern exactly: `fetchMe` writes the resolved
 * value into localStorage so that
 *
 *   1. `useDateFormatPreference()` can read it through `useSyncExternalStore`
 *      without requiring a QueryClient in the tree, and
 *   2. `<DateField>` (and any non-context helper) renders the same field
 *      order as the locale-aware `useFormatters().date()`.
 *
 * SSR always resolves AUTO (`window` is undefined); the same caveat as the
 * locale formatters applies — call sites render their formatted strings
 * post-fetch, so there is no hydration-mismatch path today.
 */

import type { Locale } from "./i18n/config";
import { type DateFormatPreference, resolveIntlLocale } from "./format-locale";

export type { DateFormatPreference } from "./format-locale";

const STORAGE_KEY = "healthlog-date-format";
const CHANGE_EVENT = "healthlog:date-format-change";

export const DATE_FORMAT_PREFERENCES = ["AUTO", "DMY", "MDY", "YMD"] as const;

/**
 * Ordered option list for the profile dropdown. `labelKey` resolves through
 * `t()` against the `settings.dateFormat.*` bundle; mirrors how the
 * hour-format select hard-codes its option order in JSX.
 */
export const DATE_FORMAT_OPTIONS: ReadonlyArray<{
  value: DateFormatPreference;
  labelKey: string;
}> = [
  { value: "AUTO", labelKey: "settings.dateFormat.auto" },
  { value: "DMY", labelKey: "settings.dateFormat.dmy" },
  { value: "MDY", labelKey: "settings.dateFormat.mdy" },
  { value: "YMD", labelKey: "settings.dateFormat.ymd" },
];

export function isDateFormatPreference(
  value: unknown,
): value is DateFormatPreference {
  return (
    typeof value === "string" &&
    (DATE_FORMAT_PREFERENCES as readonly string[]).includes(value)
  );
}

/** Best-effort read of the mirrored preference. AUTO on SSR / no mirror. */
export function readStoredDateFormat(): DateFormatPreference {
  if (typeof window === "undefined") return "AUTO";
  try {
    const stored = window.localStorage?.getItem(STORAGE_KEY);
    return isDateFormatPreference(stored) ? stored : "AUTO";
  } catch {
    return "AUTO";
  }
}

/**
 * Persist the mirror and notify same-tab subscribers. Cross-tab updates ride
 * the browser's native `storage` event.
 */
export function storeDateFormat(value: DateFormatPreference): void {
  if (typeof window === "undefined") return;
  try {
    const previous = window.localStorage?.getItem(STORAGE_KEY);
    if (previous === value) return;
    window.localStorage?.setItem(STORAGE_KEY, value);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** `useSyncExternalStore`-shaped subscription for the mirror. */
export function subscribeDateFormat(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The Intl locale tag a (preference, locale) pair renders numeric dates
 * through. Mirrors `dateOrderLocale` in `format-locale.ts`: AUTO keeps the
 * user's own locale, DMY/MDY/YMD pin a canonical locale whose default
 * numeric order matches (de-DE → dd.MM.yyyy, en-US → MM/dd/yyyy, en-CA →
 * yyyy-MM-dd). Exported so `<DateField>` and the formatter agree on order.
 */
export function resolveDateLocale(
  pref: DateFormatPreference,
  locale: Locale,
): string {
  const localeTag = resolveIntlLocale(locale);
  switch (pref) {
    case "DMY":
      return "de-DE";
    case "MDY":
      return "en-US";
    case "YMD":
      return "en-CA";
    default:
      return localeTag;
  }
}

/**
 * Format an ISO `yyyy-MM-dd` date string (or a `Date`) in the field order
 * the (preference, locale) pair selects — the user-visible string the
 * `<DateField>` paints over its hidden native input. Returns "" for an
 * empty / unparseable value so the field renders its placeholder.
 *
 * The instant is read in UTC (a bare `yyyy-MM-dd` has no zone) so the day
 * never drifts across a timezone boundary — the value contract is a plain
 * calendar date, not an instant.
 */
export function formatDate(
  value: Date | string | null | undefined,
  pref: DateFormatPreference,
  locale: Locale,
): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : parseIsoDate(value);
  if (date === null || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(resolveDateLocale(pref, locale), {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Format a plain calendar date (ISO `yyyy-MM-dd` day key or a Date) as
 * short weekday + day + month — the `fmt.dateWithWeekday` field set
 * ("Di., 14.07." / "Tue, 07/14") — pinned to UTC like {@link formatDate}.
 *
 * Issue #490: for a value that is a DAY KEY (e.g. the dose-history
 * ledger's profile-timezone day groups), parsing it as a local-midnight
 * instant and re-formatting through a timezone-aware formatter can shift
 * the rendered day when browser and profile zones differ. The calendar
 * date (and therefore its weekday) is already fully determined by the
 * key, so it renders UTC-pinned — correct in every zone, no DST edge.
 */
export function formatDateWithWeekday(
  value: Date | string | null | undefined,
  pref: DateFormatPreference,
  locale: Locale,
): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : parseIsoDate(value);
  if (date === null || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(resolveDateLocale(pref, locale), {
    timeZone: "UTC",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

/**
 * Parse a `yyyy-MM-dd` string to a UTC `Date` at midnight. Returns null on
 * a value that is not exactly the ISO calendar-date shape so callers can
 * fall back to the placeholder rather than rendering "Invalid Date".
 */
export function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  // Guard against rollover (e.g. 2026-02-31 → Mar 03): a real calendar date
  // round-trips its parts unchanged.
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return date;
}
