import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "./base-system";

const MEDCO_SECTION_DE = `METRIK — MEDIKAMENTEN-EINNAHMETREUE:
- Der Snapshot trägt overall (medicationCount, averageCompliance7, averageCompliance30) und medications[] je Medikament mit name, dose, schedulesPerDay, compliance7, compliance30, streak, taken7/skipped7/missed7, dailySeries (graded) und latestDay.
- Lies die Einnahmetreue als Prozentsatz erfüllter geplanter Dosen über die letzten 7 bzw. 30 Tage. Vergleiche compliance7 mit compliance30, um die jüngste Richtung gegen die eigene Baseline der Person zu sehen.
- Seltene Kadenz: Bei niedriger schedulesPerDay oder seltener Einnahme (z.B. Wocheninjektion) ist compliance7 rauschanfällig — eine einzige verpasste Dosis verschiebt den Prozentwert stark. Stütze die Einschätzung dann auf compliance30 (den tragenden Wert) und behandle compliance7 nur als groben Hinweis.
- Einordnung (zur Orientierung, nicht als Urteil): ≥ 90 % sehr verlässlich, 80-89 % gut, 70-79 % lückenhaft, < 70 % deutlich lückenhaft — die therapeutische Wirkung kann dann eingeschränkt sein.
- Positiv rahmen: streak ist die längste ununterbrochene Serie — bei guter Treue ausdrücklich anerkennen. Bei mehreren Medikamenten das mit der niedrigsten Treue benennen.
- Zusammenhänge zu Vitalwerten nur erwähnen, wenn ein r-Wert im Snapshot vorhanden und |r| > 0.4 ist — als Zusammenhang, nie als Ursache. Keine Wirkung erfinden, wenn die Daten fehlen.
- Eine Botschaft: Schließe NUR DANN mit EINEM machbaren Schritt, wenn der Befund einen nahelegt (z.B. Abenddosen werden häufiger vergessen — eine feste Routine oder ein Reminder zur kritischen Uhrzeit kann helfen). Bei durchgehend hoher Treue das ehrlich anerkennen, statt einen Schritt zu erzwingen. Keine Schuldzuweisung.`;

const MEDCO_SECTION_EN = `METRIC — MEDICATION ADHERENCE:
- The snapshot carries overall (medicationCount, averageCompliance7, averageCompliance30) and medications[] per medication with name, dose, schedulesPerDay, compliance7, compliance30, streak, taken7/skipped7/missed7, dailySeries (graded) and latestDay.
- Read adherence as the percentage of scheduled doses taken over the last 7 and 30 days. Compare compliance7 with compliance30 to see the recent direction against the person's own baseline.
- Rare cadence: with a low schedulesPerDay or an infrequent schedule (e.g. a weekly injection), compliance7 is noise-prone — a single missed dose swings the percentage sharply. Lean the assessment on compliance30 (the load-bearing value) and treat compliance7 only as a rough pointer.
- Placement (for orientation, not judgement): ≥ 90% very reliable, 80-89% good, 70-79% patchy, < 70% clearly patchy — therapeutic effect may then be reduced.
- Frame positively: streak is the longest uninterrupted run — acknowledge a good streak explicitly. With several medications, name the one with the lowest adherence.
- Mention links to vital signs only when an r-value is present in the snapshot and |r| > 0.4 — as an association, never a cause. Do not invent an effect when the data is absent.
- One message: close with ONE doable step that fits the gap ONLY when the finding implies one (e.g. evening doses are missed more often — a fixed routine or a reminder at the critical time can help). When adherence is consistently high, acknowledge that honestly rather than manufacturing a step. No blame.`;

export function getMedicationComplianceSystemPrompt(locale: Locale): string {
  const section = locale === "en" ? MEDCO_SECTION_EN : MEDCO_SECTION_DE;
  return `${getBaseSystemPrompt(locale)}

${section}`;
}

export function getMedicationComplianceUserPrompt(
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
Write one short assessment of this person's medication adherence: name the recent rate, place it against their own baseline (compliance7 vs compliance30), and — when something is genuinely actionable — close with one doable, blame-free step; when nothing is, skip the step rather than manufacture filler. Judge confidence from the event count and recency.${ctxBlock}${extraBlock}

${snapshotJson}`;
  }
  return `Datum: ${todayKey} (Europe/Berlin)
Schreibe eine kurze Einschätzung zur Einnahmetreue dieser Person: benenne die jüngste Rate, ordne sie gegen die eigene Baseline ein (compliance7 vs. compliance30) und schließe — wenn etwas wirklich umsetzbar ist — mit einem machbaren, wertfreien Schritt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Ereignisanzahl und Aktualität ableiten.${ctxBlock}${extraBlock}

${snapshotJson}`;
}
