/**
 * Plural-tier selection for the count-bearing message keys.
 *
 * The bundle originally carried a two-form scheme per countable string —
 * `<base>One` for 1 and `<base>Other` for everything else. That expresses
 * English, German, Spanish, French and Italian correctly, but not Polish:
 * Polish splits the non-singular range into a "few" form (2–4, 22–24, 32–34,
 * …) and a "many" form (0, 5–21, …), so a two-form scheme rendered
 * "2 godzin temu" where the language wants "2 godziny temu".
 *
 * Rather than hand-roll the modulo arithmetic, the tier comes from
 * `Intl.PluralRules`, which carries the CLDR rules for every locale we ship.
 * The three tiers map as:
 *
 *   CLDR "one"            → `One`
 *   CLDR "few"            → `Few`
 *   CLDR "many" / "other" → `Other`
 *
 * For de / en / es / fr / it the "few" category never fires on an integer, so
 * those locales resolve exactly as they did before this module existed — the
 * change is inert for them by construction, not by a special case. For Polish
 * the surviving `Other` tier carries the "many" form, which is what the key
 * already held, so only the new `Few` tier needed fresh strings.
 *
 * `Other` is the floor: an unknown category, an unsupported locale, or an
 * `Intl.PluralRules` that throws all resolve to it, which is the pre-existing
 * behaviour. A caller can therefore add the `Few` key for Polish alone and
 * every other bundle keeps working.
 */
import type { Locale } from "./config";
import { resolveIntlLocale } from "@/lib/format-locale";

export type PluralTier = "One" | "Few" | "Other";

/**
 * Select the plural tier for `count` under `locale`'s CLDR rules.
 *
 * Counts are compared as integers — every call site floors its value before
 * reaching here (minutes, hours, days, weeks, months), so the CLDR fractional
 * categories never come into play.
 */
export function pluralTier(count: number, locale: Locale): PluralTier {
  let category: Intl.LDMLPluralRule;
  try {
    category = new Intl.PluralRules(resolveIntlLocale(locale)).select(count);
  } catch {
    // A runtime without the locale data still gets the two-form behaviour
    // rather than a thrown render.
    return count === 1 ? "One" : "Other";
  }
  if (category === "one") return "One";
  if (category === "few") return "Few";
  return "Other";
}

/**
 * Build the message key for `count` from a base key.
 *
 * `pluralKey("insights.relativeHoursAgo", 3, "pl")` → `insights.relativeHoursAgoFew`.
 */
export function pluralKey(
  baseKey: string,
  count: number,
  locale: Locale,
): string {
  return `${baseKey}${pluralTier(count, locale)}`;
}
