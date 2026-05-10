/**
 * v1.4.20 phase D reconcile — shared relative-time helper.
 *
 * Formats an ISO timestamp as a localised "just now" / "N minutes ago"
 * string via i18n keys. Three Insights surfaces (hero strip, daily
 * briefing, history rail) carried byte-identical copies of this helper;
 * lift the body here so a future i18n key change lands once.
 *
 * Buckets: <1m → just-now, <1h → minutes, <24h → hours, else days.
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
  if (minutes < 60) return t("insights.relativeMinutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("insights.relativeHoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("insights.relativeDaysAgo", { count: days });
}
