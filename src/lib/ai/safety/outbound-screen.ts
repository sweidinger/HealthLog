/**
 * Unified outbound safety screen for every model-generated text the app
 * shows or stores.
 *
 * Background — what this replaces. The Coach had an outbound screen
 * (`screenCoachReply`) and nothing else did. A dose-change imperative or a
 * fabricated clinical risk score written into a per-metric status card, a
 * document summary, or the daily briefing reached the user unfiltered, while
 * the byte-identical sentence in the Coach was caught and replaced. The
 * per-surface grounding gates that DO exist grade different things: the
 * briefing gate grades NUMBERS only (and only `paragraph` / `signalsOfDay` /
 * `keyFindings`), and the causal-claim ban of GROUND RULE 12 was enforced in
 * code on exactly one surface — the period narrative. This module is the one
 * screen every model-output boundary runs, so the contracts are enforced
 * rather than merely composed into a prompt.
 *
 * Why locale is a required argument. The old signature was
 * `screenCoachReply(reply: string)` — it could not be locale-aware by
 * construction, so its banks were EN + DE stems and the dose-refusal /
 * risk-score contracts had no enforcement at all for fr / es / it / pl even
 * though the ground rules ship in all six `safety-contracts.*.yaml` files. A
 * guard that cannot see the language cannot enforce a language-specific
 * contract. Locale is now threaded from the caller's resolved reader locale.
 *
 * Why the reader's bank AND the EN bank always run. The provider is free-form
 * prose over a wire we do not control; a model answering a French reader
 * routinely emits English (a fallback model, a truncated system prompt, a
 * provider that ignores the language directive). Screening only the reader's
 * locale would let the proven EN violation shapes through on five of six
 * locales. The union costs one extra pass over a short string.
 *
 * Why patterns and not an LLM judge: deterministic, cheap, auditable, and not
 * itself promptable — the same posture as the inbound `detectRefusal`.
 *
 * Posture on false positives. The dose bank requires a CHANGE verb plus a
 * target dose with a unit, so a factual restatement the contracts explicitly
 * permit ("you're on 7.5 mg this week") does not trip — only an imperative to
 * change does. The causal bank is deliberately NOT applied to the Coach:
 * conversational prose uses "because" constantly and GROUND RULE 12's declared
 * surface is `insights`. Callers name the contracts they want; there is no
 * "screen everything" default that would silently widen a surface's contract.
 */
import type { Locale } from "@/lib/i18n/config";

/** Which contract a caller asks the screen to enforce. */
export type OutboundContract = "dose" | "risk" | "causal";

/** Why the text was blocked, for the Wide-Event annotation. */
export type OutboundReason =
  "dose_prescription" | "risk_score" | "causal_claim";

export interface OutboundDecision {
  /** True when the caller must apply its surface policy (replace / withhold). */
  block: boolean;
  /** Which contract tripped — drives Wide-Event metadata. */
  reason: OutboundReason | null;
}

/**
 * Dose units, shared across every locale. The GLP-1 + general oral-dose
 * vocabulary; `ie` / `i.e.` / `einheiten` / `unità` / `jednostk` cover the
 * insulin-unit spellings the six locales use.
 */
const DOSE_UNIT =
  "(?:mg|mcg|µg|ml|units?|unidades?|unità|unités?|jednostek|jednostki|ie|i\\.e\\.|einheiten)";

/**
 * Dose-prescription banks. Each entry requires a CHANGE verb plus a target
 * dose with a unit, so a permitted factual restatement does not match.
 *
 * The non-EN/DE verb sets are taken from the imperative vocabulary the
 * shipped `safety-contracts.{fr,es,it,pl}.yaml` ground rule 9 bodies use when
 * they forbid the act ("ne recommandez JAMAIS de valeur précise", "NUNCA
 * recomiende un valor concreto", "NON raccomandi MAI un valore specifico",
 * "NIGDY nie zalecać konkretnej wartości") plus the standard clinical
 * titration verbs of each language.
 */
const DOSE_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    // step/move/increase/raise/bump/titrate/go up to|by N unit
    new RegExp(
      `\\b(?:step|move|increase|raise|bump|titrat\\w*|go|ramp|push|up)\\s+(?:it\\s+)?(?:up\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // lower/reduce/cut/drop/decrease/back off to|by N unit
    new RegExp(
      `\\b(?:lower|reduce|cut|drop|decrease|back\\s+off|taper)\\s+(?:it\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // consider/try/should/recommend ... N unit
    new RegExp(
      `\\b(?:consider|try|you\\s+should|i'?d?\\s+recommend|i\\s+suggest)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // Experiment-shaped dose changes the "to/by N unit" patterns miss. BOTH a
    // medication object AND a trial cue are required, so a benign behavioural
    // experiment ("double your steps for two weeks") never trips.
    /\b(?:halv\w*|doubl\w*|skip\w*|stop\s+taking|quit\s+taking|come\s+off)\b[^.?!]{0,25}\b(?:dose|doses|pill|pills|tablet|tablets|medication|meds?|insulin|injection)\b[^.?!]{0,40}\b(?:for\s+\w+\s+(?:day|days|week|weeks|month|months)|to\s+(?:see|test|try|check)|next\s+(?:week|month))\b/i,
  ],
  de: [
    new RegExp(
      `\\b(?:erhöh\\w*|steiger\\w*|setz\\w*\\s+(?:hoch|rauf)|geh\\w*\\s+(?:hoch|rauf))\\s+(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:reduzier\\w*|senk\\w*|verringer\\w*|nimm\\s+(?:weniger|runter))\\s+(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\bn[äa]chste\\s+(?:stufe|dosis)\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:erwäg\\w*|probier\\w*|du\\s+solltest|ich\\s+empfehle|ich\\s+schlage\\s+vor)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    /\b(?:halbier\w*|verdoppel\w*|lass\w*\s+aus|setz\w*\s+ab|pausier\w*)\b[^.?!]{0,25}\b(?:dosis|tablette\w*|medikament\w*|spritze\w*|insulin)\b[^.?!]{0,40}\b(?:für\s+\w+\s+(?:tag|tage|woche|wochen|monat\w*)|um\s+zu\s+(?:sehen|testen)|zum\s+(?:test|ausprobieren))\b/i,
  ],
  fr: [
    // augmentez / montez / passez / portez à|de N unit
    new RegExp(
      `\\b(?:augment\\w*|mont\\w*|pass\\w*|port\\w*|majo\\w*)\\s+(?:votre\\s+dose\\s+)?(?:[àa]|de|jusqu'[àa])\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // réduisez / diminuez / baissez à|de N unit
    new RegExp(
      `\\b(?:r[ée]duis\\w*|r[ée]duire|diminu\\w*|baiss\\w*|abaiss\\w*)\\s+(?:votre\\s+dose\\s+)?(?:[àa]|de|jusqu'[àa])\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:envisagez|essayez|vous\\s+devriez|je\\s+recommande|je\\s+sugg[èe]re)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:prochaine|nouvelle)\\s+dose\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
  ],
  es: [
    // aumente / suba / pase a|en N unit
    new RegExp(
      `\\b(?:aument\\w*|sub\\w*|pas\\w*|increment\\w*)\\s+(?:su\\s+dosis\\s+)?(?:a|en|hasta)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // reduzca / baje / disminuya a|en N unit
    new RegExp(
      `\\b(?:reduzc\\w*|reduc\\w*|baj\\w*|disminu\\w*)\\s+(?:su\\s+dosis\\s+)?(?:a|en|hasta)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:considere|pruebe|deber[íi]a|recomiendo|sugiero)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:pr[óo]xima|siguiente|nueva)\\s+dosis\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
  ],
  it: [
    // aumenti / salga / passi a|di N unit
    new RegExp(
      `\\b(?:aument\\w*|sal\\w*|pass\\w*|increment\\w*)\\s+(?:la\\s+sua\\s+dose\\s+)?(?:a|di|fino\\s+a)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // riduca / abbassi / diminuisca a|di N unit
    new RegExp(
      `\\b(?:riduc\\w*|ridur\\w*|abbass\\w*|diminu\\w*|cal\\w*)\\s+(?:la\\s+sua\\s+dose\\s+)?(?:a|di|fino\\s+a)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:consideri|provi|dovrebbe|raccomando|suggerisco)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:prossima|nuova)\\s+dose\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
  ],
  pl: [
    // zwiększ / podnieś / przejdź do|o N unit
    new RegExp(
      `\\b(?:zwi[ęe]ksz\\w*|podnie[śs]\\w*|przejd[źz]\\w*|podwy[żz]sz\\w*)\\s+(?:dawk[ęe]\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // zmniejsz / obniż / zredukuj do|o N unit
    new RegExp(
      `\\b(?:zmniejsz\\w*|obni[żz]\\w*|zreduk\\w*|reduk\\w*)\\s+(?:dawk[ęe]\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:rozwa[żz]\\w*|spr[óo]buj\\w*|powinien|powinna|zalecam|sugeruj[ęe])\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:nast[ęe]pna|kolejna|nowa)\\s+dawka\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
  ],
};

/**
 * Risk-score fabrication banks. The model is grounded on a server-computed
 * snapshot and must never invent a clinical risk percentage or a named
 * risk-engine score — those are numbers the server never computed.
 */
const RISK_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    /\b\d{1,3}\s*%\s+(?:risk|chance|probability|likelihood)\b/i,
    /\b(?:risk|chance|probability|likelihood)\s+(?:of|is|at)\s+(?:about\s+|roughly\s+|~)?\d{1,3}\s*%/i,
    /\b(?:10[- ]year|ten[- ]year|lifetime)\s+(?:cardiovascular|cardiac|heart|stroke|mortality|cvd|ascvd)\s+risk\b/i,
    // Named risk engines are fabrications on any surface — the server runs none.
    /\b(?:framingham|ascvd|score2?|qrisk)\b/i,
  ],
  de: [
    /\brisiko\s+(?:von|bei|liegt\s+bei)\s+(?:etwa\s+|ungefähr\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:risiko|wahrscheinlichkeit)\b/i,
    /\b(?:10[- ]jahres|zehn[- ]jahres|lebenszeit)[- ]?(?:risiko)\b/i,
  ],
  fr: [
    /\brisque\s+(?:de|d'|est\s+de|d'environ)\s+(?:environ\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:risque|probabilit[ée]|chance)\b/i,
    /\brisque\s+(?:cardiovasculaire|cardiaque|d'avc|de\s+mortalit[ée])\s+[àa]\s+(?:10|dix)\s+ans\b/i,
  ],
  es: [
    /\briesgo\s+(?:del?|es\s+del?|de\s+aproximadamente)\s+(?:aproximadamente\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:riesgo|probabilidad)\b/i,
    /\briesgo\s+(?:cardiovascular|card[íi]aco|de\s+ictus|de\s+mortalidad)\s+a\s+(?:10|diez)\s+a[ñn]os\b/i,
  ],
  it: [
    /\brischio\s+(?:del?|dell'|[èe]\s+del?|di\s+circa)\s+(?:circa\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:di\s+)?(?:rischio|probabilit[àa])\b/i,
    /\brischio\s+(?:cardiovascolare|cardiaco|di\s+ictus|di\s+mortalit[àa])\s+a\s+(?:10|dieci)\s+anni\b/i,
  ],
  pl: [
    /\bryzyko\s+(?:wynosi\s+|około\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:ryzyka|prawdopodobie[ńn]stwa)\b/i,
    /\bryzyk\w*\s+(?:sercowo[- ]naczyniow\w*|zawału|udaru|zgonu)\s+w\s+(?:ci[ąa]gu\s+)?(?:10|dziesi[ęe]ciu)\s+lat\b/i,
  ],
};

/**
 * Causal-claim banks — GROUND RULE 12. Descriptive framing stays permitted
 * ("moved with", "was associated with", "assoziiert", "associé à"); only
 * asserted causation trips. This bank is enforced ONLY on the insights-family
 * surfaces the rule declares, never on the Coach.
 */
const CAUSAL_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    /\bbecause\b/i,
    /\bcaused?\s+by\b/i,
    /\bcaus(?:e|es|ed|ing)\b/i,
    /\bdue\s+to\b/i,
    /\bled\s+to\b/i,
    /\bresulted\s+in\b/i,
    /\bresult\s+of\b/i,
    /\bculprit\b/i,
    /\bdriven\s+by\b/i,
    /\bthanks\s+to\b/i,
    /\bowing\s+to\b/i,
    /\bresponsible\s+for\b/i,
  ],
  de: [
    /\bweil\b/i,
    /\bwegen\b/i,
    /\bverursach\w*/i,
    /\baufgrund\b/i,
    /\bführt[e]?\s+zu\b/i,
    /\bdurch\s+\w+\s+(?:verursacht|ausgelöst)\b/i,
    /\bschuld\b/i,
    /\bauslöser\b/i,
    /\bverantwortlich\s+für\b/i,
  ],
  fr: [
    /\bparce\s+qu\w*/i,
    /\b[àa]\s+cause\s+de\b/i,
    /\bcaus(?:e|es|ent|é|ée)\b/i,
    /\ben\s+raison\s+de\b/i,
    /\bentra[îi]n\w*/i,
    /\ba\s+conduit\s+[àa]\b/i,
    /\bd[ûu]\s+[àa]\b/i,
    /\bresponsable\s+de\b/i,
    /\bgr[âa]ce\s+[àa]\b/i,
    /\bprovoqu\w*/i,
  ],
  es: [
    /\bporque\b/i,
    /\bdebido\s+a\b/i,
    /\ba\s+causa\s+de\b/i,
    /\bcaus(?:a|an|ó|ado)\b/i,
    /\bprovoc\w*/i,
    /\bllev[óo]\s+a\b/i,
    /\bresponsable\s+de\b/i,
    /\bgracias\s+a\b/i,
    /\bimpuls\w*\s+(?:por|el|la)\b/i,
  ],
  it: [
    /\bperch[ée]\b/i,
    /\ba\s+causa\s+di\b/i,
    /\bcaus(?:a|ano|ato|ata)\b/i,
    /\bprovoc\w*/i,
    /\bha\s+portato\s+a\b/i,
    /\bdovuto\s+a\b/i,
    /\bresponsabile\s+di\b/i,
    /\bgrazie\s+a\b/i,
    /\bguid\w*\s+da\b/i,
  ],
  pl: [
    /\bponiewa[żz]\b/i,
    /\bz\s+powodu\b/i,
    /\bpowoduj\w*/i,
    /\bspowodowa\w*/i,
    /\bprzyczyn\w*/i,
    /\bdoprowadzi\w*\s+do\b/i,
    /\bwskutek\b/i,
    /\bdzi[ęe]ki\b/i,
    /\bodpowiedzialn\w*\s+za\b/i,
  ],
};

const BANKS: Record<OutboundContract, Record<Locale, readonly RegExp[]>> = {
  dose: DOSE_PATTERNS,
  risk: RISK_PATTERNS,
  causal: CAUSAL_PATTERNS,
};

const REASON_FOR_CONTRACT: Record<OutboundContract, OutboundReason> = {
  dose: "dose_prescription",
  risk: "risk_score",
  causal: "causal_claim",
};

/**
 * The contract set every conversational surface enforces. Causal framing is
 * deliberately absent — see the module header.
 */
export const CONVERSATIONAL_CONTRACTS: readonly OutboundContract[] = [
  "dose",
  "risk",
];

/** The contract set every insights-family surface enforces (adds GROUND RULE 12). */
export const INSIGHTS_CONTRACTS: readonly OutboundContract[] = [
  "dose",
  "risk",
  "causal",
];

/**
 * Screen one assembled model output.
 *
 * Contracts are evaluated in the caller's declared order, so the reason a
 * caller annotates is stable: dose first (highest medical-safety leverage),
 * then risk, then causal. Each contract runs the reader's locale bank plus the
 * EN bank.
 */
export function screenModelOutput(
  text: string,
  locale: Locale,
  contracts: readonly OutboundContract[],
): OutboundDecision {
  const subject = text ?? "";
  if (subject.trim().length === 0) return { block: false, reason: null };

  for (const contract of contracts) {
    const bank = BANKS[contract];
    // The reader's bank plus EN — a provider often answers in English
    // regardless of the locale directive, and EN carries the proven shapes.
    const patterns = locale === "en" ? bank.en : [...bank[locale], ...bank.en];
    for (const pattern of patterns) {
      if (pattern.test(subject)) {
        return { block: true, reason: REASON_FOR_CONTRACT[contract] };
      }
    }
  }
  return { block: false, reason: null };
}
