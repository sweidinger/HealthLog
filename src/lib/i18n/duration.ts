/**
 * Localised "8h 12m" duration label.
 *
 * Three components (the sleep-stage stacked bar, the sleep source-discrepancy
 * marker, the measurement list) carried a byte-identical private helper that
 * branched `locale === "de"` between "8 Std. 12 Min." and "8h 12m". That is a
 * de/en binary, so a Spanish, French, Italian or Polish reader got the English
 * abbreviations next to otherwise translated copy. Lift the body here and read
 * the abbreviations from the bundle so every locale gets its own convention and
 * a future wording change lands once.
 */

/** Minutes total → localised duration label. Pass `t` from `useTranslations()`. */
export function formatDurationMinutes(
  total: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const hours = Math.floor(total / 60);
  const minutes = Math.round(total - hours * 60);
  return hours > 0
    ? t("common.durationHoursMinutes", { hours, minutes })
    : t("common.durationMinutes", { minutes });
}
