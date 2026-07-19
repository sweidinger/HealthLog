/**
 * Tone rules specific to the workout surface.
 *
 * The shared rules in `tone-rules.ts` grade what every assessment surface owes:
 * a meaning-first opening, an intact locale, no value-first instruction. The
 * workout paragraph owes two more that no sibling does, and both are the kind
 * of drift that reads as helpful right up until it is a liability:
 *
 *   1. **No training prescriptions.** HealthLog describes the record. A model
 *      asked about a training session will volunteer a plan, a target zone or a
 *      next workout unless the prompt forbids it explicitly — and once one
 *      release ships a prescription, removing it reads as a regression. This is
 *      the fitness-scope-creep line, and the prompt has to state it, not imply
 *      it.
 *   2. **Own-history comparison only.** There is no population norm anywhere in
 *      the evidence block, so a prompt that invited a general standard would be
 *      inviting a fabrication.
 *
 * Both are graded on the assembled INSTRUCTION text rather than on model
 * output, for the same reason the shared rules are: it needs no provider, so it
 * can block a merge.
 */
import type { ToneViolation } from "./tone-rules";

/**
 * The prescription ban, in the reviewed instruction bodies' own words.
 *
 * Matched as a required presence, not as a banned phrase: the failure this
 * catches is a prompt that quietly DROPS the contract, which no denylist can
 * see.
 */
const PRESCRIPTION_BAN = {
  en: /NO TRAINING PRESCRIPTIONS/,
  de: /KEINE TRAININGSVORGABEN/,
} as const;

/** The specific things the ban has to enumerate to actually bind. */
const BANNED_PRESCRIPTION_TERMS = {
  en: [/next session/i, /target zone/i, /plan/i, /pace/i],
  de: [/nächste Einheit/i, /Zielzone/i, /Plan/i, /Tempo/i],
} as const;

/** Device attribution — what makes this a record of a session, not of a person. */
const DEVICE_ATTRIBUTION = {
  en: /ATTRIBUTE THE FIGURES TO THE DEVICE/,
  de: /SCHREIBE DIE ZAHLEN DEM GERÄT ZU/,
} as const;

/** Own-history-only comparison. */
const OWN_HISTORY_ONLY = {
  en: /COMPARE ONLY TO history/,
  de: /VERGLEICHE AUSSCHLIESSLICH mit history/,
} as const;

/** Effort acknowledged where the numbers show it — the point of the surface. */
const EFFORT_ACKNOWLEDGED = {
  en: /ACKNOWLEDGE EFFORT WHERE THE NUMBERS SHOW IT/,
  de: /ERKENNE ANSTRENGUNG AN, WO DIE ZAHLEN SIE ZEIGEN/,
} as const;

/**
 * Grade the assembled workout prompt against the session contract.
 *
 * `instructionBody` is which reviewed body the locale composes — de for German
 * readers, en for everyone else — not the reader's locale, because a French
 * prompt carries the ENGLISH instruction text plus a French output directive.
 */
export function checkWorkoutToneContract(input: {
  systemPrompt: string;
  userPrompt: string;
  instructionBody: "en" | "de";
}): ToneViolation[] {
  const violations: ToneViolation[] = [];
  const { systemPrompt, userPrompt, instructionBody: body } = input;
  const both = `${systemPrompt}\n${userPrompt}`;

  if (!PRESCRIPTION_BAN[body].test(systemPrompt)) {
    violations.push({
      rule: "workout-bans-training-prescriptions",
      detail:
        "the system prompt no longer carries the no-training-prescriptions contract — the fitness-scope-creep line is unguarded",
    });
  }

  for (const term of BANNED_PRESCRIPTION_TERMS[body]) {
    if (!term.test(systemPrompt)) {
      violations.push({
        rule: "workout-prescription-ban-is-specific",
        detail: `the ban does not name ${term} — a general "no advice" line does not bind a model that is about to suggest one`,
      });
    }
  }

  if (!DEVICE_ATTRIBUTION[body].test(systemPrompt)) {
    violations.push({
      rule: "workout-attributes-to-the-device",
      detail:
        "the prompt no longer asks for device attribution — the paragraph would read as a measurement of the person",
    });
  }

  if (!OWN_HISTORY_ONLY[body].test(systemPrompt)) {
    violations.push({
      rule: "workout-compares-to-own-history-only",
      detail:
        "the own-history-only comparison instruction is gone; there is no population norm in the evidence block, so any general standard would be invented",
    });
  }

  if (!EFFORT_ACKNOWLEDGED[body].test(systemPrompt)) {
    violations.push({
      rule: "workout-acknowledges-earned-effort",
      detail:
        "the earned-recognition instruction is gone — the surface degrades to a dry readout",
    });
  }

  // The paragraph is rendered as React text children and there is no markdown
  // library in this project. A prompt that asked for markup would produce
  // literal asterisks on screen at best.
  if (/\bmarkdown\b/i.test(both)) {
    violations.push({
      rule: "workout-requests-no-markup",
      detail: "the prompt mentions markdown; this surface renders plain text",
    });
  }

  return violations;
}
