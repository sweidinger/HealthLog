/**
 * v1.18.10 (HIGH-2) — Coach OUTBOUND safety screen.
 *
 * `detectRefusal()` guards the INBOUND channel (the user's message) only. The
 * model's reply was tokenised and streamed verbatim with no equivalent
 * server-side check, so a dose-prescription ("step up to 2.4 mg") or a
 * fabricated risk score in the assistant turn reached the user unfiltered. The
 * GLP-1 dose-safety contract and grounding block are composed into the Coach
 * system prompt, but those are instructions, not enforcement.
 *
 * The chat route already buffers the full reply before streaming (the provider
 * clients return the body in one shot, then `tokeniseForStreaming` chunks it
 * for the UI), so the practical screen runs on the assembled reply BEFORE
 * persistence and streaming. On a trip the route swaps in a safe fallback turn
 * — the user sees a calm "talk to your prescriber" message, never the
 * fabricated/prescriptive text.
 *
 * Posture, mirroring the inbound detector:
 *  - Pattern-based + deterministic, so it is cheap and auditable; an LLM judge
 *    would itself be promptable.
 *  - Errs toward catching: the dose-prescription patterns are tight (a verb +
 *    a target dose with a unit), so an ordinary "you're on 7.5 mg this week"
 *    factual restatement (which the contract explicitly PERMITS) does not trip
 *    — only an imperative to change the dose does.
 */
import type { Locale } from "@/lib/i18n/config";

/** Why the outbound reply was blocked, for the Wide-Event annotation. */
export type CoachOutboundReason = "dose_prescription" | "risk_score";

export interface CoachOutboundDecision {
  /** True when the assembled reply must be replaced with the fallback. */
  block: boolean;
  /** Which screen tripped — drives Wide-Event metadata. */
  reason: CoachOutboundReason | null;
}

/**
 * Dose-prescription patterns. Each requires a CHANGE verb + a target dose with
 * a unit, so a factual restatement of the current step ("you are on 7.5 mg",
 * "week 3 on 7.5 mg") — which the GLP-1 contract permits — does not match,
 * while an imperative ("step up to 2.4 mg", "increase to 10 mg", "erhöhe auf
 * 7,5 mg") does. The unit set covers the GLP-1 + general oral-dose vocabulary.
 */
const DOSE_UNIT = "(?:mg|mcg|µg|ml|units?|ie|i\\.e\\.|einheiten)";

const DOSE_PRESCRIPTION_PATTERNS: readonly RegExp[] = [
  // EN: step/move/increase/raise/bump/titrate/go up to|by N unit
  new RegExp(
    `\\b(?:step|move|increase|raise|bump|titrat\\w*|go|ramp|push|up)\\s+(?:it\\s+)?(?:up\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
    "i",
  ),
  // EN: lower/reduce/cut/drop/decrease/back off to|by N unit
  new RegExp(
    `\\b(?:lower|reduce|cut|drop|decrease|back\\s+off|taper)\\s+(?:it\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
    "i",
  ),
  // EN: consider/try/should/recommend ... N unit dose
  new RegExp(
    `\\b(?:consider|try|you\\s+should|i'?d?\\s+recommend|i\\s+suggest)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
    "i",
  ),
  // DE: erhöhe/steigere/geh hoch auf|um N unit
  new RegExp(
    `\\b(?:erhöh\\w*|steiger\\w*|setz\\w*\\s+(?:hoch|rauf)|geh\\w*\\s+(?:hoch|rauf))\\s+(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
    "i",
  ),
  // DE: reduziere/senke/verringere auf|um N unit
  new RegExp(
    `\\b(?:reduzier\\w*|senk\\w*|verringer\\w*|nimm\\s+(?:weniger|runter))\\s+(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
    "i",
  ),
  // DE: nächste Stufe / nächste Dosis N unit (recommend-shaped)
  new RegExp(
    `\\bn[äa]chste\\s+(?:stufe|dosis)\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
    "i",
  ),
  // v1.22 (W9, C2): experiment-shaped dose changes the "to/by N unit" patterns
  // miss — halve/double/skip/stop a DOSE or named medication AS AN EXPERIMENT.
  // Both a nearby medication object AND a trial cue ("for two weeks", "to see")
  // are required, so benign behavioral experiments ("double your steps for two
  // weeks") and refusals ("changing a dose isn't something to test") never trip.
  /\b(?:halv\w*|doubl\w*|skip\w*|stop\s+taking|quit\s+taking|come\s+off)\b[^.?!]{0,25}\b(?:dose|doses|pill|pills|tablet|tablets|medication|meds?|insulin|injection)\b[^.?!]{0,40}\b(?:for\s+\w+\s+(?:day|days|week|weeks|month|months)|to\s+(?:see|test|try|check)|next\s+(?:week|month))\b/i,
  // DE: halbier/verdoppel/lass aus/setz ab/pausier — Dosis/Tablette + Versuchs-Cue
  /\b(?:halbier\w*|verdoppel\w*|lass\w*\s+aus|setz\w*\s+ab|pausier\w*)\b[^.?!]{0,25}\b(?:dosis|tablette\w*|medikament\w*|spritze\w*|insulin)\b[^.?!]{0,40}\b(?:für\s+\w+\s+(?:tag|tage|woche|wochen|monat\w*)|um\s+zu\s+(?:sehen|testen)|zum\s+(?:test|ausprobieren))\b/i,
];

/**
 * Risk-score fabrication patterns: the Coach is grounded on the snapshot and
 * must never invent a computed clinical risk percentage / score. A "10-year
 * cardiovascular risk of 12%" or a fabricated "your risk score is 8/10" is a
 * number the server never computed and the snapshot never carried.
 */
const RISK_SCORE_PATTERNS: readonly RegExp[] = [
  // EN: <N>% (cardiovascular|heart|stroke|mortality|...) risk
  /\b\d{1,3}\s*%\s+(?:risk|chance|probability|likelihood)\b/i,
  /\b(?:risk|chance|probability|likelihood)\s+(?:of|is|at)\s+(?:about\s+|roughly\s+|~)?\d{1,3}\s*%/i,
  /\b(?:10[- ]year|ten[- ]year|lifetime)\s+(?:cardiovascular|cardiac|heart|stroke|mortality|cvd|ascvd)\s+risk\b/i,
  /\b(?:framingham|ascvd|score2?|qrisk)\b/i,
  // DE: Risiko von N% / N% Risiko
  /\brisiko\s+(?:von|bei|liegt\s+bei)\s+(?:etwa\s+|ungefähr\s+|~)?\d{1,3}\s*%/i,
  /\b\d{1,3}\s*%\s+(?:risiko|wahrscheinlichkeit)\b/i,
  /\b(?:10[- ]jahres|zehn[- ]jahres|lebenszeit)[- ]?(?:risiko)\b/i,
];

/**
 * Screen an assembled assistant reply. Runs the dose-prescription patterns
 * first (highest medical-safety leverage), then the risk-score patterns.
 */
export function screenCoachReply(reply: string): CoachOutboundDecision {
  const text = reply ?? "";
  if (text.trim().length === 0) {
    return { block: false, reason: null };
  }
  for (const pattern of DOSE_PRESCRIPTION_PATTERNS) {
    if (pattern.test(text)) {
      return { block: true, reason: "dose_prescription" };
    }
  }
  for (const pattern of RISK_SCORE_PATTERNS) {
    if (pattern.test(text)) {
      return { block: true, reason: "risk_score" };
    }
  }
  return { block: false, reason: null };
}

/**
 * Safe fallback copy when the outbound screen trips. de/en carry a native
 * body; the other UI locales ride the EN body (the Coach itself replies in
 * de/en, so this is the consistent posture with the inbound refusal copy).
 * Exposed as constants so server-only code (tests, logs) can pin the wording.
 */
export const COACH_OUTBOUND_DOSE_BLOCK_EN =
  "I can't suggest a specific medication dose or a change to one — dose decisions belong with your prescribing clinician. I can help you read what your own data shows around your medication; ask me about that and I'll stay grounded in your numbers.";

export const COACH_OUTBOUND_DOSE_BLOCK_DE =
  "Eine konkrete Medikamenten-Dosis oder eine Dosisänderung kann ich nicht vorschlagen — solche Entscheidungen gehören zu deiner behandelnden Ärztin oder deinem Arzt. Gerne helfe ich dir, das zu lesen, was deine eigenen Daten rund um deine Medikation zeigen; frag mich danach, dann bleibe ich bei deinen Zahlen.";

export const COACH_OUTBOUND_RISK_BLOCK_EN =
  "I can't put a number on a clinical risk like that — it isn't something your tracked data lets me compute, and an invented figure would be misleading. I can walk you through what your own measurements are doing instead; ask me about a specific metric.";

export const COACH_OUTBOUND_RISK_BLOCK_DE =
  "Eine solche klinische Risikozahl kann ich nicht angeben — deine erfassten Daten lassen das nicht berechnen, und ein erfundener Wert wäre irreführend. Stattdessen kann ich dir zeigen, was deine eigenen Messwerte machen; frag mich nach einer konkreten Metrik.";

/** Resolve the localised fallback copy for a tripped outbound screen. */
export function coachOutboundFallback(
  reason: CoachOutboundReason,
  locale: Locale,
): string {
  const de = locale === "de";
  if (reason === "dose_prescription") {
    return de ? COACH_OUTBOUND_DOSE_BLOCK_DE : COACH_OUTBOUND_DOSE_BLOCK_EN;
  }
  return de ? COACH_OUTBOUND_RISK_BLOCK_DE : COACH_OUTBOUND_RISK_BLOCK_EN;
}
