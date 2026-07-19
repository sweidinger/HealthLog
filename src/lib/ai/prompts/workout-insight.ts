import type { Locale } from "@/lib/i18n/config";
import { getBaseSystemPromptBody } from "./base-system";
import { instructionLocale, withOutputLanguage } from "./output-language";

/**
 * Per-workout Activity Insight prompt.
 *
 * The one surface in the assessment family that describes a SINGLE EVENT
 * rather than a metric's trajectory, so it composes the shared base body — the
 * opening shape, the earned-warmth tone contract, the non-diagnostic framing,
 * the forbidden-filler list, the JSON output clause — and then overrides the
 * data shape the same way the biomarker card does.
 *
 * Three things this prompt has to hold that no sibling needs:
 *
 *   1. **Device attribution.** The figures came off a watch or a strap, not
 *      off a lab bench. Saying so is honest about the precision on offer and
 *      is what makes the paragraph read as a record of the session rather than
 *      as a measurement of the person.
 *   2. **No prescriptions.** Not a plan, not a target zone, not a next
 *      session. This is the fitness-scope-creep line, and it is the single
 *      easiest contract for a workout prompt to drift across — a model asked
 *      about a training session will volunteer training advice unless told
 *      plainly not to. HealthLog describes the record; it does not coach a
 *      training plan.
 *   3. **Own history only.** The comparison is to this person's own median for
 *      this sport. There is no population norm in the evidence block and there
 *      must be none in the prose.
 */

/** Bumped whenever the instruction text changes; rides the input hash. */
export const WORKOUT_INSIGHT_PROMPT_VERSION = "1.0.0" as const;

const WORKOUT_SECTION_EN = `METRIC — ONE RECORDED SESSION:
- DIFFERENT DATA SHAPE: this snapshot carries NO signal block. The base instruction's fields that reference signal do not apply here. Instead: sportType, durationSec, distanceM, climbM, activeEnergyKcal, avgHr/maxHr/minHr, zoneSeconds (seconds per effort zone, ascending), hr (the session's heart-rate shape: firstHalfMeanBpm, secondHalfMeanBpm, driftBpm, peaks, medianSettleSec) and history (this person's own median for this sport over the lookback window).
- You are describing ONE session that has already happened, not a metric's trend. Everything is already computed; STATE it, do NOT recompute it.
- ATTRIBUTE THE FIGURES TO THE DEVICE that recorded them ("your watch put most of it in…", "the strap recorded…"). These are device readings of a session, not measurements of the person.
- COMPARE ONLY TO history — this person's own recent median for this sport. When history is absent or its sampleSize is small, say there is not much to compare against yet rather than reaching for a general standard. There is no population norm in this snapshot and none may appear in the reply.
- ACKNOWLEDGE EFFORT WHERE THE NUMBERS SHOW IT: a long session, a climb, time held in the upper zones, a faster settle after peaks than the person's usual. Earned recognition is the point of this surface. Unearned praise is not — a short easy session is described as a short easy session, which is a perfectly good thing to have done.
- NO TRAINING PRESCRIPTIONS. Do not suggest a next session, a weekly plan, a target zone, a pace, a duration, a recovery window or an intensity. Do not say what the person "should" train. This surface describes the session that happened and stops there.
- Absent fields are absent, not zero: no route means nothing about terrain, no hr block means nothing about the shape of the effort.
- Non-diagnostic: no fitness verdict, no health claim, no attribution of cause.`;

const WORKOUT_SECTION_DE = `METRIK — EINE AUFGEZEICHNETE EINHEIT:
- ABWEICHENDE DATENFORM: Dieser Snapshot trägt KEINEN signal-Block. Die Felder der Basisanweisung, die auf signal verweisen, gelten hier nicht. Stattdessen: sportType, durationSec, distanceM, climbM, activeEnergyKcal, avgHr/maxHr/minHr, zoneSeconds (Sekunden je Belastungszone, aufsteigend), hr (der Herzfrequenzverlauf der Einheit: firstHalfMeanBpm, secondHalfMeanBpm, driftBpm, peaks, medianSettleSec) und history (der eigene Median dieser Person für diese Sportart im Rückblickfenster).
- Du beschreibst EINE bereits stattgefundene Einheit, keinen Metrik-Verlauf. Alles ist bereits berechnet; benenne es, rechne es NICHT neu.
- SCHREIBE DIE ZAHLEN DEM GERÄT ZU, das sie aufgezeichnet hat („deine Uhr hat den größten Teil davon in … gelegt", „der Gurt hat … aufgezeichnet"). Das sind Gerätemesswerte einer Einheit, keine Messungen der Person.
- VERGLEICHE AUSSCHLIESSLICH mit history — dem eigenen Median dieser Person für diese Sportart. Fehlt history oder ist sampleSize klein, sage, dass es noch wenig zum Vergleichen gibt, statt auf einen allgemeinen Maßstab auszuweichen. In diesem Snapshot steht keine Bevölkerungsnorm, und in der Antwort darf keine auftauchen.
- ERKENNE ANSTRENGUNG AN, WO DIE ZAHLEN SIE ZEIGEN: eine lange Einheit, Höhenmeter, Zeit in den oberen Zonen, ein schnelleres Zurückkommen nach Spitzen als sonst bei dieser Person. Verdiente Anerkennung ist der Sinn dieser Fläche. Unverdientes Lob nicht — eine kurze lockere Einheit wird als kurze lockere Einheit beschrieben, und das ist völlig in Ordnung.
- KEINE TRAININGSVORGABEN. Schlage keine nächste Einheit vor, keinen Wochenplan, keine Zielzone, kein Tempo, keine Dauer, kein Regenerationsfenster, keine Intensität. Sage nicht, was die Person trainieren „sollte". Diese Fläche beschreibt die stattgefundene Einheit und hört dort auf.
- Fehlende Felder fehlen, sie sind nicht null: keine Route heißt nichts über das Gelände, kein hr-Block heißt nichts über den Verlauf der Anstrengung.
- Nicht diagnostisch: kein Fitnessurteil, keine Gesundheitsaussage, keine Ursachenzuschreibung.`;

export function getWorkoutInsightSystemPrompt(locale: Locale): string {
  // fr/es/it/pl compose the ENGLISH body (the base prompt names their language
  // and `withOutputLanguage` appends their own directive last); only de takes
  // the German one. Never the `locale === "en" ? "en" : "de"` binary that sent
  // four locales a German prompt.
  const section =
    instructionLocale(locale) === "en"
      ? WORKOUT_SECTION_EN
      : WORKOUT_SECTION_DE;
  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${section}`,
    locale,
  );
}

export function getWorkoutInsightUserPrompt(
  evidenceJson: string,
  todayKey: string,
  locale: Locale,
  /** Rotating opener-archetype hint; see metric-archetypes.ts. */
  openerHint?: string,
): string {
  const openerLine =
    openerHint && openerHint.trim().length > 0
      ? `\nOPENER HINT: ${openerHint}`
      : "";

  if (instructionLocale(locale) === "en") {
    return `Date: ${todayKey}${openerLine}
Write 3 to 4 sentences about this one recorded session. Open with what the session WAS in plain words — the character of it, not the number (e.g. "a steady, aerobic-leaning ride", "a short sharp one with two hard efforts in it") — then bring in ONE concrete figure from the snapshot right after as support. Attribute the figures to the device that recorded them. Place the session against this person's own recent median for the sport and against nothing else. Acknowledge the effort where the numbers show it, plainly and without exclamation. Do not prescribe any training — no next session, no plan, no target zone, no pace.

${evidenceJson}`;
  }

  return `Datum: ${todayKey}${openerLine}
Schreibe 3 bis 4 Sätze über diese eine aufgezeichnete Einheit. Beginne mit dem CHARAKTER der Einheit in klaren Worten — wie sie war, nicht der Zahl (z. B. „eine ruhige, aerob geprägte Ausfahrt", „eine kurze knackige mit zwei harten Abschnitten") — und bring danach EINE konkrete Zahl aus dem Snapshot als Beleg. Schreibe die Zahlen dem Gerät zu, das sie aufgezeichnet hat. Ordne die Einheit gegen den eigenen Median dieser Person für die Sportart ein und gegen nichts sonst. Erkenne die Anstrengung an, wo die Zahlen sie zeigen, sachlich und ohne Ausrufezeichen. Gib keinerlei Trainingsvorgaben — keine nächste Einheit, keinen Plan, keine Zielzone, kein Tempo.

${evidenceJson}`;
}
