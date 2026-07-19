/**
 * The arrival reaction line — one sentence, written once per arrival kind per
 * local day, that replaces the Today hero's standing lead for the rest of the
 * day.
 *
 * This is the smallest AI surface in the product and it is deliberately the
 * most constrained. It says ONE thing: something landed, and here is what it
 * means against this person's own history. It is not a summary, not a plan,
 * and not an assessment card — those surfaces exist and this one must not
 * drift into them.
 *
 * LOCALE — the load-bearing detail. The body composes through
 * `getBaseSystemPromptBody(locale)` and closes with `withOutputLanguage`,
 * which is the SIX-locale path: German readers get the German body, and
 * fr/es/it/pl get the English body plus a directive, in their own language,
 * naming the language to write in. Do NOT reintroduce a local
 * `locale === "de" ? "German" : "English"` here — that two-locale collapse is
 * exactly the defect the base-system path was fixed to remove, and it silently
 * ships English prose to four locales.
 */
import type { Locale } from "@/lib/i18n/config";
import type { ArrivalKind } from "@/lib/arrivals/types";

import { getBaseSystemPromptBody } from "./base-system";
import { instructionLocale, withOutputLanguage } from "./output-language";

/**
 * The reaction contract, appended to the shared assessment base.
 *
 * Every clause here is a bound on FORM, not on content — the base prompt
 * already owns the safety contract (no diagnosis, no prescription, earned
 * encouragement, associations never causal). What this adds is the shape that
 * makes a one-line reaction readable in a hero: verdict first, the number as
 * support rather than as the opener, and a hard stop at one sentence.
 */
const REACTION_CONTRACT_EN = `SURFACE — THE ARRIVAL REACTION LINE:
- Write EXACTLY ONE sentence. Not two. It renders as a single hero line and anything longer is truncated.
- Lead with the MEANING, not the measurement. "A solid night, deeper than your recent stretch — 7 h 12 min behind it" reads correctly; "Your sleep is 7 h 12 min" does not. The figure is support; it may appear, but never as the opening clause.
- Compare against THIS PERSON'S OWN recent baseline, which the evidence block carries already computed. State it; never recompute it, never invent a comparison the block does not contain.
- Never exclamatory. No exclamation marks, no "great job", no congratulation the numbers did not earn. An unfavourable reading is named plainly and without alarm.
- Never diagnostic and never prescriptive: no condition names, no risk levels, no dose or treatment suggestions, no training instructions.
- When the evidence block is too thin to support a verdict, say so plainly in that one sentence. A manufactured verdict is worse than an honest "not much to go on yet".
- Plain text only — no markdown, no quotation marks around the sentence, no emoji.`;

const REACTION_CONTRACT_DE = `OBERFLÄCHE — DIE REAKTIONSZEILE ZUM DATENEINGANG:
- Schreibe GENAU EINEN Satz. Nicht zwei. Er erscheint als einzelne Hero-Zeile; alles Längere wird abgeschnitten.
- Führe mit der BEDEUTUNG, nicht mit dem Messwert. "Eine solide Nacht, tiefer als zuletzt — 7 h 12 min tragen sie" liest sich richtig; "Dein Schlaf beträgt 7 h 12 min" nicht. Die Zahl stützt; sie darf vorkommen, aber nie als einleitender Satzteil.
- Vergleiche gegen die EIGENE jüngste Baseline dieser Person, die der Evidenzblock bereits fertig berechnet mitführt. Nenne sie; rechne sie nicht neu und erfinde keinen Vergleich, den der Block nicht enthält.
- Nie ausrufend. Keine Ausrufezeichen, kein "super gemacht", kein Lob, das die Zahlen nicht hergeben. Ein ungünstiger Wert wird sachlich und ohne Alarm benannt.
- Nie diagnostisch und nie verordnend: keine Krankheitsnamen, keine Risikostufen, keine Dosis- oder Therapievorschläge, keine Trainingsanweisungen.
- Wenn der Evidenzblock zu dünn für ein Urteil ist, sage das in diesem einen Satz klar. Ein konstruiertes Urteil ist schlechter als ein ehrliches "dafür ist es noch zu wenig".
- Nur Fließtext — kein Markdown, keine Anführungszeichen um den Satz, keine Emojis.`;

export function getArrivalReactionSystemPrompt(locale: Locale): string {
  // fr/es/it/pl compose the ENGLISH body — the base prompt names their own
  // language and `withOutputLanguage` appends their directive last, so the
  // language instruction is the final thing the model reads.
  const contract =
    instructionLocale(locale) === "en"
      ? REACTION_CONTRACT_EN
      : REACTION_CONTRACT_DE;

  return withOutputLanguage(
    `${getBaseSystemPromptBody(locale)}

${contract}`,
    locale,
  );
}

/** What kind of arrival the line is reacting to, in the model's own terms. */
const KIND_SUBJECT: Record<ArrivalKind, string> = {
  sleep_night: "last night's completed sleep",
  workout: "a workout the person just finished",
  weight: "the first weight reading of the day",
  blood_pressure: "a fresh blood-pressure reading",
  labs_panel: "a new lab panel",
};

export interface ArrivalReactionPromptInput {
  kind: ArrivalKind;
  /**
   * The deterministic, already-grounded evidence the digest read path
   * computed. Passed verbatim — the model is never asked to derive a figure,
   * only to say what the block already establishes.
   */
  evidence: string;
}

export function getArrivalReactionUserPrompt(
  input: ArrivalReactionPromptInput,
): string {
  return `WHAT JUST LANDED: ${KIND_SUBJECT[input.kind]}.

EVIDENCE BLOCK — everything below is already computed from this person's own record. Use only what is here; if it does not support a verdict, say so.
${input.evidence}

Write the one-sentence reaction line. Return only the sentence.`;
}
