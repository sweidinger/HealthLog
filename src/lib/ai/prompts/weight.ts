import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const WEIGHT_SECTION_DE = `METRIK — GEWICHT:
- Der Snapshot trägt weight.summary + weight.series (graded). weight.latestDayFocus zeigt den jüngsten Tageswert, den Schritt zum vorherigen Messtag und ggf. den Blutdruck desselben Tages.
- Wochen-/Monatstrend zählt, nicht der Einzelwert: Vergleiche das recent-Mittel mit dem weekly/monthly-Mittel der Person. Tageschwankungen von 1-2 kg (Wasser, Tageszeit) sind normal und kein Befund.
- Plateau: Verändert sich das Mittel über > ~2 Wochen um < 0.5 kg, ist das ein Plateau — bei einem Abnehmenden ehrlich benennen, ohne zu entmutigen.
- Tempo: Nachhaltiger Verlust liegt bei ~0.5-1.0 kg/Woche (DGE). Anhaltend > 1 kg/Woche ist eher Wasser/Muskel als Fett — vorsichtig einordnen.
- Meilensteine gegen das eigene Maximum: ~5 % Verlust vom höchsten Wert (series-Max) bringt bereits metabolischen Nutzen, ~10 % einen deutlichen — wenn erreicht, ausdrücklich anerkennen.
- BMI-Bezug nur, wenn die Größe im Profil vorliegt (sonst nicht behaupten). WHO-Bänder zur groben Einordnung, nie als Etikett für die Person.
- Zusammenhänge: weightVsSystolic.correlation / weightVsMeanBloodPressure.correlation und moodContext.moodVsWeightCorrelation nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache.
- Eine Botschaft: Schließe mit EINEM machbaren Schritt, der zur Richtung passt (z.B. bei einem Plateau zur selben Tageszeit wiegen, um den echten Trend zu sehen, statt am Tagesrauschen zu hängen).`;

const WEIGHT_SECTION_EN = `METRIC — WEIGHT:
- The snapshot carries weight.summary + weight.series (graded). weight.latestDayFocus shows the latest daily value, the step from the previous measured day and, where present, the same-day blood pressure.
- The weekly/monthly trend matters, not the single value: compare the recent mean with the person's weekly/monthly mean. Day-to-day swings of 1-2 kg (water, time of day) are normal and not a finding.
- Plateau: if the mean moves < 0.5 kg over > ~2 weeks, that is a plateau — name it honestly for someone who is losing, without discouraging.
- Pace: sustainable loss is ~0.5-1.0 kg/week (DGE). Sustained > 1 kg/week is more likely water/muscle than fat — frame cautiously.
- Milestones against their own maximum: ~5% loss from the highest value (series max) already brings metabolic benefit, ~10% a substantial one — acknowledge explicitly when reached.
- BMI reference only when height is in the profile (do not claim it otherwise). WHO bands for rough placement, never as a label for the person.
- Associations: mention weightVsSystolic.correlation / weightVsMeanBloodPressure.correlation and moodContext.moodVsWeightCorrelation only when present and |r| > 0.4 — as an association, never a cause.
- One message: close with ONE doable step that fits the direction (e.g. on a plateau, weigh at the same time of day to see the real trend rather than the daily noise).`;

export function getWeightSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? WEIGHT_SECTION_EN : WEIGHT_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getWeightUserPrompt(
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
Write one short assessment of this person's weight: name the current level and direction, place the recent days against their own weekly/monthly baseline (the trend, not the single value), and close with one doable step. Judge confidence from the measurement count and recency.${ctxBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung zum Gewicht dieser Person: benenne Niveau und Richtung, ordne die jüngsten Tage gegen die eigene Wochen-/Monats-Baseline ein (der Trend, nicht der Einzelwert) und schließe mit einem machbaren Schritt. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}

${snapshotJson}`;
}
