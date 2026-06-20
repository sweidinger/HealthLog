import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const PULSE_SECTION_DE = `METRIK — PULS / HERZFREQUENZ:
- Der Snapshot trägt pulse.signal (der fertige Vergleich), pulse.summary + pulse.series (graded) und pulse.target (greenMin/greenMax/orangeMin/orangeMax, inTargetPctLast30DailyPoints). pulse.latestDayFocus zeigt den jüngsten Tageswert und den Schritt zum Vortag.
- Tendenz über Wochen: Führe mit pulse.signal — current, delta gegenüber baselineLabel und outsideNormalSwing sind bereits berechnet. NENNE sie, rechne sie NICHT neu. Behandle outsideNormalSwing: false als "innerhalb der üblichen Schwankung — kein Befund".
- Richtung: Ein über Wochen sinkender Ruhepuls deutet auf bessere kardiovaskuläre Fitness; ein steigender kann auf Stress, Schlafmangel oder Übertraining hinweisen — als mögliche Erklärung, nie als Diagnose.
- Einordnungs-Anker (Ruhepuls): athletisch 50-60, normal 60-100. Werte im Band 80-100 sind technisch normal, langfristig aber günstiger niedriger. < 50 oder > 100 über mehrere Tage ist erwähnenswert, ohne zu alarmieren.
- Medikamenten-Bezug: Betablocker senken die Herzfrequenz. moodContext.moodVsPulseCorrelation und ein pulseVsSystolic-Zusammenhang nur erwähnen, wenn vorhanden und |r| > 0.4 — als Zusammenhang, nie als Ursache.
- Eine Botschaft: Liegt der Ruhepuls über der eigenen Baseline, schließe NUR DANN mit EINEM machbaren Schritt, wenn der Befund einen nahelegt (z.B. ein paar Tage morgens vor dem Aufstehen messen, um eine saubere Ruhe-Baseline zu bekommen). Verbessert er sich oder ist er stabil, erkenne das ehrlich an und nenne stattdessen einen Punkt, den man im Auge behalten kann, statt einen Schritt zu erzwingen.`;

const PULSE_SECTION_EN = `METRIC — PULSE / HEART RATE:
- The snapshot carries pulse.signal (the finished comparison), pulse.summary + pulse.series (graded) and pulse.target (greenMin/greenMax/orangeMin/orangeMax, inTargetPctLast30DailyPoints). pulse.latestDayFocus shows the latest daily value and the step from the prior day.
- Trend over weeks: lead from pulse.signal — current, delta vs baselineLabel and outsideNormalSwing are already computed. STATE them, do NOT recompute. Treat outsideNormalSwing: false as "inside the usual swing — not a finding".
- Direction: a resting pulse falling over weeks suggests improving cardiovascular fitness; a rising one can point to stress, sleep loss or overtraining — as a possible explanation, never a diagnosis.
- Placement anchors (resting pulse): athletic 50-60, normal 60-100. Values in the 80-100 band are technically normal but tend to be more favourable lower over the long run. < 50 or > 100 across several days is worth noting without alarm.
- Medication link: beta-blockers lower heart rate. Mention moodContext.moodVsPulseCorrelation and any pulse-vs-systolic association only when present and |r| > 0.4 — as an association, never a cause.
- One message: if the resting pulse sits above the person's baseline, close with ONE doable step ONLY when the finding implies one (e.g. take readings on waking for a few days to get a clean resting baseline). If it is improving or steady, acknowledge that honestly and name one thing worth keeping an eye on instead of manufacturing a step.`;

export function getPulseSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? PULSE_SECTION_EN : PULSE_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getPulseUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  previousContextBlock?: string,
  /** v1.12.7 — diversity / anti-repetition context; see blood-pressure.ts. */
  assessmentContextBlock?: string,
): string {
  const ctxBlock =
    previousContextBlock && previousContextBlock.trim().length > 0
      ? `\n\n${previousContextBlock}\n`
      : "";
  const extraBlock =
    assessmentContextBlock && assessmentContextBlock.trim().length > 0
      ? `\n\n${assessmentContextBlock}\n`
      : "";
  if (locale === "en") {
    return `Date: ${todayKey} (Europe/Berlin)
Write one short assessment of this person's resting pulse: name the current level, place the recent days against their own weekly/monthly baseline, and — when something is genuinely actionable — close with one doable step; when nothing is, skip the step rather than manufacture filler. Judge confidence from the measurement count and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung zum Ruhepuls dieser Person: benenne das aktuelle Niveau, ordne die jüngsten Tage gegen die eigene Wochen-/Monats-Baseline ein und schließe — wenn etwas wirklich umsetzbar ist — mit einem machbaren Schritt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Messanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
