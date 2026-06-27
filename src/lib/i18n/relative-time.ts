/**
 * v1.4.20 phase D reconcile — shared relative-time helper.
 *
 * Formats an ISO timestamp as a localised "just now" / "N minutes ago"
 * string via i18n keys. Three Insights surfaces (hero strip, daily
 * briefing, history rail) carried byte-identical copies of this helper;
 * lift the body here so a future i18n key change lands once.
 *
 * Buckets: <1m → just-now, <1h → minutes, <24h → hours, else days.
 *
 * v1.4.43 H6 — pluralisation. Each bucket now branches on `count === 1`
 * to read the *One key (singular) or *Other key (plural), matching the
 * dashboard.staleHintWeeksOne / Other pattern already in the bundle.
 * Eliminates the "vor 1 Minuten" grammar bug a German user spotted.
 */
export function formatRelativeTime(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "";
  const diffMs = Date.now() - target;
  if (diffMs < 60_000) return t("insights.relativeJustNow");
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return t(
      minutes === 1
        ? "insights.relativeMinutesAgoOne"
        : "insights.relativeMinutesAgoOther",
      { count: minutes },
    );
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t(
      hours === 1
        ? "insights.relativeHoursAgoOne"
        : "insights.relativeHoursAgoOther",
      { count: hours },
    );
  }
  const days = Math.floor(hours / 24);
  return t(
    days === 1
      ? "insights.relativeDaysAgoOne"
      : "insights.relativeDaysAgoOther",
    { count: days },
  );
}

/**
 * v1.18.9 — date-only relative label, shared with the medication card grammar.
 *
 * Buckets a calendar date against "now": same day → `medications.today`
 * ("Heute"), the day before → `medications.yesterday` ("Gestern"), otherwise
 * the absolute date through the caller's locale formatter. The today /
 * yesterday i18n keys are the SAME ones the medication card renders for its
 * last-taken line, so a Vorsorge "zuletzt erledigt" reads identically.
 *
 * Day-bucketing uses an `en-CA` (YYYY-MM-DD) day key — locale-independent and
 * string-comparable — formatted in the supplied IANA `timeZone` so the
 * boundary follows the user's zone, not the server's. `formatDate` renders the
 * absolute fallback (pass the locale `fmt.date`).
 */
export function relativeCalendarDate(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (value: Date) => string,
  timeZone?: string,
): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "";
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const targetDay = dayFormatter.format(target);
  if (targetDay === dayFormatter.format(now)) return t("medications.today");
  if (targetDay === dayFormatter.format(yesterday))
    return t("medications.yesterday");
  return formatDate(target);
}

/**
 * v1.22 (W6) — "Updated …" freshness label for the insight surfaces.
 *
 * Replaces the bare relative read ("2 hours ago") on the briefing + per-metric
 * cards with a calendar-bucketed label that shows the TIME only for today:
 *   - today     → "Updated today, 14:30"   (time via the locale formatter)
 *   - yesterday → "Updated yesterday"        (no time)
 *   - older     → "Updated on 14.06."        (date-only, honours the user's
 *                  DateFormatPreference via the passed `formatDate`)
 *
 * Day-bucketing uses an `en-CA` (YYYY-MM-DD) key formatted in `timeZone` so the
 * boundary follows the user's zone, matching `relativeCalendarDate`. `formatDate`
 * + `formatTime` come from the locale formatters hook (`useFormatters` →
 * `fmt.dateShort` / `fmt.time`), so both honour the user's locale + preferences.
 */
export function formatUpdatedLabel(
  iso: string,
  t: (key: string, params?: Record<string, string | number>) => string,
  formatDate: (value: Date) => string,
  formatTime: (value: Date) => string,
  timeZone?: string,
): string {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return "";
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const targetDay = dayFormatter.format(target);
  if (targetDay === dayFormatter.format(now)) {
    return t("insights.updatedTodayAt", { time: formatTime(target) });
  }
  if (targetDay === dayFormatter.format(yesterday)) {
    return t("insights.updatedYesterday");
  }
  return t("insights.updatedOn", { date: formatDate(target) });
}
