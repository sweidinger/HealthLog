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
    // lower/reduce/cut/drop/decrease/back off/taper(ing) to|by N unit
    new RegExp(
      `\\b(?:lower|reduce|cut|drop|decrease|back\\s+off|taper\\w*)\\s+(?:it\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
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
    // German puts the verb last in a subordinate clause ("auf 7,5 mg zu
    // erhöhen"), so the verb-first patterns above miss the most natural
    // phrasing of the instruction. Match the inverted order too.
    new RegExp(
      `\\b(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b[^.?!]{0,30}\\b(?:erhöh\\S*|steiger\\S*|reduzier\\S*|senk\\S*|verringer\\S*|hochsetz\\S*)`,
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
      `\\b(?:zwi[ęe]ksz\\S*|podnie[śs]\\S*|przejd[źz]\\S*|podwy[żz]sz\\S*)\\s+(?:dawk\\S*\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    // zmniejsz / obniż / zredukuj do|o N unit
    new RegExp(
      `\\b(?:zmniejsz\\S*|obni[żz]\\S*|zreduk\\S*|reduk\\S*)\\s+(?:dawk\\S*\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:rozwa[żz]\\S*|spr[óo]buj\\S*|powinien|powinna|zalecam|sugeruj[ęe])[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}\\b`,
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
 *
 * v1.32.7 (Coach Guard I — D1/D4). The bare-engine and bare-horizon patterns
 * are GONE: a bare mention ("an ASCVD score is what your clinician computes")
 * is education or a refusal, exactly what the system prompt asks for, and the
 * old bank blocked it — the "generic clinical-risk refusal" loop the
 * maintainer kept hitting. A fabrication is the ASSERTION, not the mention:
 *
 *   - a qualifying NUMBER — a digit percent, a spelled-out percent word
 *     ("roughly twelve percent"), or "score of N" — attached to a risk noun,
 *     the 10-year horizon phrase, or a named engine, OR
 *   - a categorical engine/horizon RESULT — "SCORE2 would put you in the
 *     high-risk band" — even with no digits.
 *
 * The horizon token itself ("10-year … risk") is NOT a qualifying number, so a
 * model-perfect refusal that names it passes with no exemption. There is
 * deliberately no refusal-context exemption (it was a hedge-then-assert bypass:
 * "I can't compute your ASCVD, but your risk is about 14%").
 */
// Spelled-out cardinal numbers (0–99) so a digit-less "twelve percent" still
// counts as a fabricated figure, not an educational aside.
const SPELLED_EN =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?";
const PCT_WORD_EN = `${SPELLED_EN}\\s+(?:percent|per\\s+cent)`;
const QUAL_NUM_EN = `(?:\\d{1,3}\\s*%|${PCT_WORD_EN}|score\\s+of\\s+\\d)`;
const RISK_NOUN_EN = "(?:risk|chance|probability|likelihood)";
const ENGINE = "(?:framingham|ascvd|score2|qrisk)";
const HORIZON_EN =
  "(?:10[- ]year|ten[- ]year|lifetime)\\s+(?:cardiovascular|cardiac|heart|stroke|mortality|cvd|ascvd)\\s+risk";
const RESULT_VERB_EN =
  "(?:puts?\\s+you|would\\s+put\\s+you|placing\\s+you|places?\\s+you|you\\s+fall|you'?d\\s+fall|classif\\w*\\s+you)";
const RISK_BAND_EN =
  "(?:high|higher|intermediate|elevated|moderate|low|borderline)[- ]?risk\\s+(?:band|category|group|range)";
// A categorical VERDICT on the engine / horizon itself ("your 10-year risk IS
// elevated") — a fabricated result with no digits. The horizon phrase and a
// named engine are inherently about-this-user, so an attached risk-level
// adjective is an assertion, not education. A model-perfect refusal names the
// horizon but attaches no such adjective, so it still passes.
const RISK_LEVEL_EN =
  "(?:elevated|high|higher|intermediate|moderate|borderline|raised|concerning|significant)";
const RISK_VERDICT_EN = `(?:is|are|looks?|appears?|seems?|sits?|remains?|comes?\\s+back|runs?|suggests?|indicat\\w*|shows?|reflects?|points?\\s+to)\\s+(?:\\w+\\s+){0,2}${RISK_LEVEL_EN}`;
const SPELLED_DE =
  "(?:null|eins?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)";
const PCT_WORD_DE = `${SPELLED_DE}\\s+prozent`;
const QUAL_NUM_DE = `(?:\\d{1,3}\\s*%|${PCT_WORD_DE})`;
const RISK_NOUN_DE = "(?:risiko|wahrscheinlichkeit|chance)";
const HORIZON_DE = "(?:10[- ]jahres|zehn[- ]jahres|lebenszeit)[- ]?risiko";
const RESULT_VERB_DE =
  "(?:ordnet\\s+(?:dich|sie)\\s+ein|stuft\\s+(?:dich|sie)\\s+ein|f[äa]llst\\s+in|einordnen|liegst\\s+im)";
const RISK_BAND_DE =
  "(?:hoh|niedrig|mittler|erhöht|moderat|gering)\\w*[- ]?risiko(?:bereich|kategorie|gruppe|band)";
const RISK_LEVEL_DE =
  "(?:erhöht|hoch|höher|mittel|mäßig|grenzwertig|besorgniserregend|deutlich)";
const RISK_VERDICT_DE = `(?:ist|liegt|erscheint|wirkt|bleibt|zeigt|deutet\\s+auf|weist\\s+auf)\\s+(?:\\w+\\s+){0,2}${RISK_LEVEL_DE}`;

/*
 * v1.32.7 narrowed EN + DE only; v1.32.9 (Coach Guard II / B.6) brings fr / es
 * / it / pl to parity: a spelled-out percent counts as a fabricated figure, the
 * named engine blocks with a qualifying number in either order, and a
 * categorical engine RESULT ("SCORE2 vous met dans la tranche à haut risque")
 * blocks numberless. The digit-percent + horizon patterns each locale already
 * shipped stay. Spelled-out cardinals cover 0–19 + the tens a realistic risk
 * percentage uses.
 */
const SPELLED_FR =
  "(?:zéro|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante)";
const PCT_WORD_FR = `${SPELLED_FR}\\s+(?:pour\\s+cent|pour-cent)`;
const QUAL_NUM_FR = `(?:\\d{1,3}\\s*%|${PCT_WORD_FR})`;
const RISK_NOUN_FR = "(?:risque|probabilité|chance)";
const RESULT_VERB_FR =
  "(?:vous\\s+(?:met|place|situe|classe|met\\s+dans)|vous\\s+êtes\\s+(?:dans|classé)|vous\\s+tombez\\s+dans)";
const SPELLED_ES =
  "(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta)";
const PCT_WORD_ES = `${SPELLED_ES}\\s+por\\s+ciento`;
const QUAL_NUM_ES = `(?:\\d{1,3}\\s*%|${PCT_WORD_ES})`;
const RISK_NOUN_ES = "(?:riesgo|probabilidad)";
const RESULT_VERB_ES =
  "(?:lo\\s+(?:coloca|sitúa|clasifica|pone)|le\\s+(?:coloca|sitúa|clasifica)|se\\s+encuentra\\s+en|está\\s+en\\s+(?:la\\s+)?categor|cae\\s+en)";
const SPELLED_IT =
  "(?:zero|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|trenta|quaranta|cinquanta|sessanta)";
const PCT_WORD_IT = `${SPELLED_IT}\\s+per\\s+cento`;
const QUAL_NUM_IT = `(?:\\d{1,3}\\s*%|${PCT_WORD_IT})`;
const RISK_NOUN_IT = "(?:rischio|probabilità)";
const RESULT_VERB_IT =
  "(?:la\\s+(?:colloca|mette|classifica|pone)|rientra\\s+(?:in|nella)|si\\s+trova\\s+(?:in|nella)|ricade\\s+in)";
const SPELLED_PL =
  "(?:zero|jeden|dwa|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|jedenaście|dwanaście|trzynaście|czternaście|piętnaście|szesnaście|siedemnaście|osiemnaście|dziewiętnaście|dwadzieścia|trzydzieści|czterdzieści|pięćdziesiąt|sześćdziesiąt)";
const PCT_WORD_PL = `${SPELLED_PL}\\s+procent`;
const QUAL_NUM_PL = `(?:\\d{1,3}\\s*%|${PCT_WORD_PL})`;
const RISK_NOUN_PL = "(?:ryzyk\\w*|prawdopodobieństw\\w*)";
const RESULT_VERB_PL =
  "(?:umieszcza\\s+(?:cię|pana|panią)|klasyfikuje\\s+(?:cię|pana|panią)|znajdujesz\\s+się\\s+w|wpadasz\\s+w|kwalifikuje\\s+(?:cię|pana|panią))";

const RISK_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    // (1) digit percent adjacent to a risk noun, either order
    new RegExp(`\\b\\d{1,3}\\s*%\\s+${RISK_NOUN_EN}\\b`, "i"),
    new RegExp(
      `\\b${RISK_NOUN_EN}\\s+(?:of|is|at|around|about|near|sits?\\s+at|would\\s+be)\\s+(?:about\\s+|roughly\\s+|approximately\\s+|around\\s+|~)?\\d{1,3}\\s*%`,
      "i",
    ),
    // (2) spelled-out percent as a risk figure, either order (D4b)
    new RegExp(`\\b${RISK_NOUN_EN}\\b[^.?!]{0,40}\\b${PCT_WORD_EN}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_EN}\\b[^.?!]{0,40}\\b${RISK_NOUN_EN}\\b`, "i"),
    // (3) 10-year horizon phrase + a qualifying number, either order (M4)
    new RegExp(`\\b${HORIZON_EN}\\b[^.?!]{0,40}${QUAL_NUM_EN}`, "i"),
    new RegExp(`${QUAL_NUM_EN}[^.?!]{0,40}\\b${HORIZON_EN}\\b`, "i"),
    // (4) named engine + a qualifying number, either order
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_EN}`, "i"),
    new RegExp(`${QUAL_NUM_EN}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    // (5) engine / horizon + a categorical RESULT assertion, numberless (D4)
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,60}${RESULT_VERB_EN}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,60}${RISK_BAND_EN}`,
      "i",
    ),
    // (6) engine / horizon + a categorical risk-level verdict, numberless
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,40}${RISK_VERDICT_EN}`,
      "i",
    ),
  ],
  de: [
    new RegExp(
      `\\brisiko\\s+(?:von|bei|liegt\\s+bei)\\s+(?:etwa\\s+|ungefähr\\s+|~)?\\d{1,3}\\s*%`,
      "i",
    ),
    new RegExp(`\\b\\d{1,3}\\s*%\\s+${RISK_NOUN_DE}\\b`, "i"),
    // spelled-out percent as a risk figure, either order
    new RegExp(`\\b${RISK_NOUN_DE}\\b[^.?!]{0,40}\\b${PCT_WORD_DE}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_DE}\\b[^.?!]{0,40}\\b${RISK_NOUN_DE}\\b`, "i"),
    // 10-year horizon + a qualifying number, either order
    new RegExp(`\\b${HORIZON_DE}\\b[^.?!]{0,40}${QUAL_NUM_DE}`, "i"),
    new RegExp(`${QUAL_NUM_DE}[^.?!]{0,40}\\b${HORIZON_DE}\\b`, "i"),
    // named engine (same literals) + qualifying number or categorical result
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_DE}`, "i"),
    new RegExp(`${QUAL_NUM_DE}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_DE})\\b[^.?!]{0,60}${RESULT_VERB_DE}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_DE})\\b[^.?!]{0,60}${RISK_BAND_DE}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_DE})\\b[^.?!]{0,40}${RISK_VERDICT_DE}`,
      "i",
    ),
  ],
  fr: [
    /\brisque\s+(?:est\s+)?(?:de\s+|d['’])?(?:environ\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:risque|probabilit[ée]|chance)/i,
    /\brisque\s+(?:cardiovasculaire|cardiaque|d'avc|de\s+mortalit[ée])\s+[àa]\s+(?:10|dix)\s+ans\b/i,
    // digit percent as a risk figure, either order (the noun need not be adjacent)
    new RegExp(`\\b${RISK_NOUN_FR}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_FR}\\b`, "i"),
    // spelled-out percent as a risk figure, either order
    new RegExp(`\\b${RISK_NOUN_FR}\\b[^.?!]{0,40}\\b${PCT_WORD_FR}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_FR}\\b[^.?!]{0,40}\\b${RISK_NOUN_FR}\\b`, "i"),
    // named engine + qualifying number, either order
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_FR}`, "i"),
    new RegExp(`${QUAL_NUM_FR}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    // engine + categorical result assertion, numberless
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_FR}`, "i"),
  ],
  es: [
    /\briesgo\s+(?:del?|es\s+del?|de\s+aproximadamente)\s+(?:aproximadamente\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:riesgo|probabilidad)/i,
    /\briesgo\s+(?:cardiovascular|card[íi]aco|de\s+ictus|de\s+mortalidad)\s+a\s+(?:10|diez)\s+a[ñn]os\b/i,
    new RegExp(`\\b${RISK_NOUN_ES}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_ES}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_ES}\\b[^.?!]{0,40}\\b${PCT_WORD_ES}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_ES}\\b[^.?!]{0,40}\\b${RISK_NOUN_ES}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_ES}`, "i"),
    new RegExp(`${QUAL_NUM_ES}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_ES}`, "i"),
  ],
  it: [
    /\brischio\s+(?:del?|dell'|[èe]\s+del?|di\s+circa)\s+(?:circa\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:di\s+)?(?:rischio|probabilit[àa])/i,
    /\brischio\s+(?:cardiovascolare|cardiaco|di\s+ictus|di\s+mortalit[àa])\s+a\s+(?:10|dieci)\s+anni\b/i,
    new RegExp(`\\b${RISK_NOUN_IT}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_IT}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_IT}\\b[^.?!]{0,40}\\b${PCT_WORD_IT}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_IT}\\b[^.?!]{0,40}\\b${RISK_NOUN_IT}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_IT}`, "i"),
    new RegExp(`${QUAL_NUM_IT}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_IT}`, "i"),
  ],
  pl: [
    /\bryzyko\s+(?:wynosi\s+|około\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:ryzyka|prawdopodobie[ńn]stwa)/i,
    /\bryzyk\w*\s+(?:sercowo[- ]naczyniow\w*|zawału|udaru|zgonu)\s+w\s+(?:ci[ąa]gu\s+)?(?:10|dziesi[ęe]ciu)\s+lat\b/i,
    new RegExp(`\\b${RISK_NOUN_PL}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_PL}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_PL}\\b[^.?!]{0,40}\\b${PCT_WORD_PL}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_PL}\\b[^.?!]{0,40}\\b${RISK_NOUN_PL}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_PL}`, "i"),
    new RegExp(`${QUAL_NUM_PL}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_PL}`, "i"),
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
    /\ba\s+conduit\s+[àa]/i,
    /\bd[ûu]\s+[àa]/i,
    /\bresponsable\s+de\b/i,
    /\bgr[âa]ce\s+[àa]/i,
    /\bprovoqu\w*/i,
  ],
  es: [
    /\bporque\b/i,
    /\bdebido\s+a\b/i,
    /\ba\s+causa\s+de\b/i,
    /\bcaus(?:a|an|ó|ado)/i,
    /\bprovoc\w*/i,
    /\bllev[óo]\s+a\b/i,
    /\bresponsable\s+de\b/i,
    /\bgracias\s+a\b/i,
    /\bimpuls\w*\s+(?:por|el|la)\b/i,
  ],
  it: [
    /\bperch[ée]/i,
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
    /\bponiewa[żz]/i,
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
 * Continuation-exclusion for the dose bank (v1.32.7 — D7). A sentence that
 * matches a dose pattern is EXEMPT only when it is anchored to a maintenance
 * object ("keep taking … as prescribed") AND carries no change stem. So
 * "you should keep taking your prescribed 7.5 mg" passes, while
 * "you should keep in mind that trying 5 mg" (no maintenance anchor) and
 * "you should continue tapering to 2.4 mg" (a change stem present) stay
 * blocked. The direction is exclusion-of-continuation, never
 * requirement-of-change — "you should try 5 mg" must keep blocking.
 *
 * Accepted residual FP, failing safe: "I'd recommend discussing the 2.4 mg
 * step with your doctor" stays blocked ("step" is a change stem).
 */
const DOSE_CONTINUATION: Record<Locale, RegExp> = {
  en: /\b(?:keep\s+taking|keep\s+on\s+taking|continue\s+(?:taking|with|on)|stay(?:ing)?\s+(?:on|at)|remain(?:ing)?\s+on|as\s+prescribed|as\s+directed)\b/i,
  de: /\b(?:weiterhin|weiter\s+(?:einnehmen|nehmen)|nimm\s+weiter|beibehalten|behalte\s+bei|wie\s+(?:verordnet|verschrieben|besprochen)|bleib(?:e|st)?\s+bei)\b/i,
  fr: /\b(?:continuez?\s+(?:à|de|le)|gardez|comme\s+prescrit|tel\s+que\s+prescrit)\b/i,
  es: /\b(?:siga\s+(?:tomando|con)|continúe|mantenga|según\s+lo\s+prescrito)\b/i,
  it: /\b(?:continui\s+(?:a|con|il)|mantenga|come\s+prescritto)\b/i,
  pl: /\b(?:kontynuuj|przyjmuj\s+dalej|zgodnie\s+z\s+zaleceniem|pozosta[ńn]\s+przy)\b/i,
};

const DOSE_CHANGE_STEM: Record<Locale, RegExp> = {
  en: /\b(?:increas|reduc|taper|titrat|step\s+(?:up|down)|lower|raise|halv|doubl|skip|bump|ramp)\w*/i,
  de: /\b(?:erhöh|steiger|reduzier|senk|verringer|halbier|verdoppel|absetz|auslass|hochsetz|runtersetz|titrier)\w*/i,
  fr: /\b(?:augment|réduis|réduir|diminu|baiss|abaiss|doubl|arrêt|saut)\w*/i,
  es: /\b(?:aument|reduzc|reduc|baj|disminu|dobl|omit|salt)\w*/i,
  it: /\b(?:aument|riduc|ridur|abbass|diminu|raddoppi|salt|dimezz)\w*/i,
  pl: /\b(?:zwiększ|zmniejsz|obniż|podnie[śs]|podwyższ|zreduk|pomi[ńn]|opu[śs][ćc])\w*/i,
};

/** Sentence-level split — the dose exemption must be scoped to one sentence. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!\n])\s+/);
}

/** Every leading-magnitude dose value in one sentence ("keep your 7.5 mg" → [7.5]). */
const DOSE_VALUE_RE = new RegExp(`([\\d.,]+)\\s*${DOSE_UNIT}\\b`, "gi");
function sentenceDoseValues(sentence: string): number[] {
  const values: number[] = [];
  let m: RegExpExecArray | null;
  DOSE_VALUE_RE.lastIndex = 0;
  while ((m = DOSE_VALUE_RE.exec(sentence)) !== null) {
    // Normalise a comma decimal ("7,5") and a stray thousands/decimal tail.
    const cleaned = m[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const value = Number.parseFloat(cleaned);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** True when a dose value matches a scheduled dose (exact / ±2%). */
function matchesSchedule(
  values: readonly number[],
  schedule: readonly number[],
): boolean {
  return values.some((v) =>
    schedule.some((s) => Math.abs(v - s) <= Math.max(0.01, Math.abs(s) * 0.02)),
  );
}

/**
 * True when a dose-change imperative trips, honouring the continuation rule.
 *
 * v1.32.9 (Coach Guard II / G3 — M6/D7 end state): when `scheduleDoses` is
 * supplied (the Coach passes the user's active doses), the continuation
 * exemption ALSO requires the sentence's dose to match one the user is actually
 * on. So "keep taking your 7.5 mg" passes only when 7.5 is a scheduled dose;
 * "keep taking your 15 mg" when the schedule says 7.5 is a wrong maintenance
 * dose and stays blocked. Without a schedule (every non-Coach surface) the
 * Guard I phrase-anchored exemption stands unchanged.
 */
function doseTrips(
  subject: string,
  locale: Locale,
  scheduleDoses?: readonly number[],
): boolean {
  const bank = BANKS.dose;
  const patterns = locale === "en" ? bank.en : [...bank[locale], ...bank.en];
  const continuation =
    locale === "en"
      ? [DOSE_CONTINUATION.en]
      : [DOSE_CONTINUATION[locale], DOSE_CONTINUATION.en];
  const changeStem =
    locale === "en"
      ? [DOSE_CHANGE_STEM.en]
      : [DOSE_CHANGE_STEM[locale], DOSE_CHANGE_STEM.en];
  const gateOnSchedule =
    scheduleDoses !== undefined && scheduleDoses.length > 0;
  for (const sentence of splitSentences(subject)) {
    if (!patterns.some((p) => p.test(sentence))) continue;
    let exempt =
      continuation.some((p) => p.test(sentence)) &&
      !changeStem.some((p) => p.test(sentence));
    if (exempt && gateOnSchedule) {
      // The continuation phrasing is only trusted when the dose it names is one
      // the user is actually on. An off-schedule maintenance dose is caught.
      exempt = matchesSchedule(sentenceDoseValues(sentence), scheduleDoses);
    }
    if (!exempt) return true;
  }
  return false;
}

/**
 * Screen one assembled model output.
 *
 * Contracts are evaluated in the caller's declared order, so the reason a
 * caller annotates is stable: dose first (highest medical-safety leverage),
 * then risk, then causal. Each contract runs the reader's locale bank plus the
 * EN bank.
 */
export interface ScreenOptions {
  /**
   * v1.32.9 — the user's active medication doses (numeric magnitudes). When
   * present, the dose continuation exemption is additionally gated on a match:
   * a "keep taking your N mg" is trusted only when N is a scheduled dose. Only
   * the Coach passes this; every other surface keeps the phrase-anchored rule.
   */
  scheduleDoses?: readonly number[];
}

export function screenModelOutput(
  text: string,
  locale: Locale,
  contracts: readonly OutboundContract[],
  opts?: ScreenOptions,
): OutboundDecision {
  const subject = text ?? "";
  if (subject.trim().length === 0) return { block: false, reason: null };

  for (const contract of contracts) {
    if (contract === "dose") {
      // Dose is sentence-scoped so the continuation exemption cannot be
      // voided by a change stem in an unrelated sentence.
      if (doseTrips(subject, locale, opts?.scheduleDoses)) {
        return { block: true, reason: REASON_FOR_CONTRACT.dose };
      }
      continue;
    }
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
