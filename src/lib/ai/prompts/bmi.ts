import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const BMI_SECTION_DE = `METRIK — BMI:
- Der Snapshot trägt bmi.summary + bmi.series (graded). bmi.latestDayFocus zeigt den jüngsten Wert, dessen WHO-Klassifikation und den Schritt zum Vortag; bmi.target ist das grüne Band (18.5-24.9).
- Trend vor Momentaufnahme: Vergleiche das recent-Mittel mit dem weekly/monthly-Mittel der Person und benenne die Richtung — ein einzelner Tageswert trägt wenig.
- WHO-Bänder zur groben Einordnung, nie als Etikett für die Person: Untergewicht < 18.5, Normal 18.5-24.9, Übergewicht 25.0-29.9, Adipositas I 30.0-34.9, II 35.0-39.9, III ≥ 40.0. Ab 65+ gilt 22-27 als günstig (DEGAM).
- Grenzen des BMI offen ansprechen: Er misst keine Körperzusammensetzung und ist bei muskulösen oder sehr sportlichen Personen wenig aussagekräftig.
- Eine Botschaft: Schließe mit EINEM machbaren Schritt, der zur Richtung passt — bei stabilem Wert im günstigen Band das ehrlich anerkennen, statt einen Befund zu erzwingen.`;

const BMI_SECTION_EN = `METRIC — BMI:
- The snapshot carries bmi.summary + bmi.series (graded). bmi.latestDayFocus shows the latest value, its WHO classification and the step from the prior day; bmi.target is the green band (18.5-24.9).
- Trend over snapshot: compare the recent mean with the person's weekly/monthly mean and name the direction — a single daily value carries little.
- WHO bands for rough placement, never as a label for the person: Underweight < 18.5, Normal 18.5-24.9, Overweight 25.0-29.9, Obesity I 30.0-34.9, II 35.0-39.9, III ≥ 40.0. From age 65+, 22-27 counts as favourable (DEGAM).
- Name BMI's limits plainly: it does not measure body composition and is weakly informative for muscular or very athletic people.
- One message: close with ONE doable step that fits the direction — when the value is stable in the favourable band, acknowledge that honestly rather than forcing a finding.`;

export function getBmiSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? BMI_SECTION_EN : BMI_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getBmiUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
): string {
  const ctxBlock =
    previousContextBlock && previousContextBlock.trim().length > 0
      ? `\n\n${previousContextBlock}\n`
      : "";
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Write one short assessment of this person's BMI: name the current value and WHO band, place the recent trend against their own weekly/monthly baseline, and close with one doable step. Judge confidence from the measurement count and recency.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung zum BMI dieser Person: benenne den aktuellen Wert und das WHO-Band, ordne den jüngsten Trend gegen die eigene Wochen-/Monats-Baseline ein und schließe mit einem machbaren Schritt. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}

${snapshotJson}`;
}
