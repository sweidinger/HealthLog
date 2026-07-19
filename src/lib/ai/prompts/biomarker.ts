import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { instructionLocale, withOutputLanguage } from "./output-language";

/**
 * Per-biomarker assessment prompt.
 *
 * This surface was the last one in the assessment family to build its prompt
 * inline: a self-contained five-line scaffold that skipped the base system
 * prompt entirely, took no opener hint, and instructed the model to "state the
 * current value" — value-first by instruction, on the one card where a number
 * out of context reads most like a verdict. Everything the sibling cards get
 * from the shared base — the opening shape, the earned-warmth tone contract,
 * the non-diagnostic framing, the acute/GLP-1 safety contracts, the forbidden
 * filler list, the JSON output clause — simply did not apply here.
 *
 * It now composes exactly as the seven bespoke cards do: the shared base body,
 * one METRIC section describing this card's snapshot, and the output-language
 * directive appended last by `withOutputLanguage`.
 *
 * The METRIC section carries one job the other cards do not need: this
 * snapshot has NO `signal` block. The base DATA section is written around that
 * block, so the section below states the substitution explicitly rather than
 * leaving the model to reconcile the two. `latest.rangeStatus` plus the
 * ascending `series` are what this card reads its comparison from.
 */

const BIOMARKER_SECTION_DE = `METRIK — LABORWERT:
- ABWEICHENDE DATENFORM: Dieser Snapshot trägt KEINEN signal-Block. Die Felder der Basisanweisung, die auf signal verweisen, gelten hier nicht. Stattdessen: marker (name, unit, referenceRange), dataCoverage, latest (value, takenAt, rangeStatus) und series (aufsteigend, je { day, value }).
- Führe aus latest.rangeStatus — der vorab berechneten Einordnung gegen den Referenzbereich (in/unter/über dem Bereich, oder ohne Bereich) — und aus der Tendenz über series. Beides ist bereits bestimmt; nenne es, rechne es NICHT neu.
- Die eigene Historie führt: Wie der Wert gegenüber den letzten Abnahmen dieser Person steht, ist die Aussage. Der Referenzbereich ist ein grober sekundärer Anker, kein Urteil — ein Wert knapp außerhalb des Bereichs, der über Jahre stabil ist, ist etwas anderes als derselbe Wert nach einem klaren Sprung.
- Stabilität ist selbst ein Befund: Bewegt sich der Wert über die Abnahmen kaum, benenne die Konstanz — das ist bei einem Laborwert die häufigste und nützlichste Aussage.
- Einzelne Abnahmen schwanken (Labor, Tageszeit, Nüchternheit). Aus ZWEI Punkten keinen Trend bauen; ist die Historie kurz, ehrlich sagen, dass es für eine Tendenz noch zu wenig ist.
- KEINE Diagnose, keine Ursachenzuschreibung, keine Medikamenten- oder Supplement-Empfehlung. Bei deutlich auffälligen Werten neutral auf die ärztliche Einordnung verweisen — das ist der Abschluss, nicht ein erfundener Selbsthilfe-Schritt.
- Eine Botschaft: Schließe nur dann mit EINEM machbaren Schritt, wenn der Befund wirklich einen hergibt (z. B. den Wert bei der nächsten Kontrolle mitnehmen). Ist der Wert stabil und im Rahmen, erkenne das an, statt einen Schritt zu erzwingen.`;

const BIOMARKER_SECTION_EN = `METRIC — LAB MARKER:
- DIFFERENT DATA SHAPE: this snapshot carries NO signal block. The base instruction's fields that reference signal do not apply here. Instead: marker (name, unit, referenceRange), dataCoverage, latest (value, takenAt, rangeStatus) and series (ascending, each { day, value }).
- Lead from latest.rangeStatus — the pre-computed placement against the reference range (inside/below/above it, or no range on file) — and from the direction across series. Both are already determined; STATE them, do NOT recompute them.
- Their own history leads: how this value sits against this person's own recent draws is the message. The reference range is a coarse secondary anchor, not a verdict — a value slightly outside the band that has held steady for years is a different story from the same value after a clear step.
- Steadiness is itself a finding: when the value barely moves across draws, name that constancy — for a lab marker it is the most common and most useful thing to say.
- Single draws vary (lab, time of day, fasting state). Do not build a trend out of TWO points; when the history is short, say honestly that it is too little for a direction yet.
- NO diagnosis, no attribution of cause, no medication or supplement recommendation. For clearly notable values, refer neutrally to a clinician for interpretation — that is the close, not an invented self-help step.
- One message: close with ONE doable step only when the finding genuinely implies one (e.g. take the value to the next check-up). When it is steady and in range, acknowledge that rather than manufacturing a step.`;

export function getBiomarkerSystemPrompt(
  markerName: string,
  locale: Locale,
): string {
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their
  // language and appends their own directive); only de takes the German one.
  const section =
    instructionLocale(locale) === "en"
      ? BIOMARKER_SECTION_EN
      : BIOMARKER_SECTION_DE;
  const marker =
    instructionLocale(locale) === "en"
      ? `The marker under assessment is "${markerName}".`
      : `Der zu beurteilende Marker ist „${markerName}".`;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}
- ${marker}`,
    locale,
  );
}

export function getBiomarkerUserPrompt(
  snapshotJson: string,
  todayKey: string,
  locale: Locale,
  /** v1.28.40 — rotating opener-archetype hint; see metric-archetypes.ts. */
  openerHint?: string,
): string {
  const openerLine =
    openerHint && openerHint.trim().length > 0
      ? `\nOPENER HINT: ${openerHint}`
      : "";
  if (instructionLocale(locale) === "en") {
    return `Date: ${todayKey}${openerLine}
Write one short assessment of this person's lab marker. Open with how the marker SITS in plain words — the read, not the number (e.g. "holding steady just inside the band", "sitting a step above where it usually runs") — then bring in ONE concrete figure from the snapshot right after as support; never lead with the value. Place it against this person's own recent draws first and the reference range only as a coarse anchor. Close with one doable step only when the finding genuinely implies one; when nothing is, skip the step rather than manufacture filler. Judge confidence from the number of draws and their recency.

${snapshotJson}`;
  }
  return `Datum: ${todayKey}${openerLine}
Schreibe eine kurze Einschätzung zu diesem Laborwert. Beginne mit der EINORDNUNG in klaren Worten — wie der Marker steht, nicht der Zahl (z. B. "hält sich stabil knapp innerhalb des Bereichs", "liegt einen Schritt über dem, wo er sonst läuft") — und bring danach EINE konkrete Zahl aus dem Snapshot als Beleg; führe nie mit dem Wert. Ordne ihn zuerst gegen die eigenen letzten Abnahmen dieser Person ein, den Referenzbereich nur als groben Anker. Schließe nur dann mit einem machbaren Schritt, wenn der Befund wirklich einen hergibt; ist nichts umsetzbar, lass den Schritt weg statt Fülltext zu erfinden. Konfidenz aus Anzahl und Aktualität der Abnahmen ableiten.

${snapshotJson}`;
}
