/**
 * Deterministic tone rules for the assessment surfaces.
 *
 * The live-judge eval under `src/lib/ai/coach/eval/` grades MODEL OUTPUT and
 * needs a provider key, so it can only run conditionally. This module grades
 * the two things that are available with no provider at all:
 *
 *   1. the assembled PROMPT text every assessment surface sends, and
 *   2. the DETERMINISTIC FALLBACK text those surfaces render when no provider
 *      is configured or the call stalls.
 *
 * That is enough to catch the regression classes that actually happened. Every
 * tone regression this repo has shipped was visible in the prompt before it was
 * ever visible in the prose: a surface built its prompt inline and skipped the
 * shared opening contract; a locale silently composed the German body; an
 * instruction told the model to state the value first. Those are string facts,
 * so they are checkable in the normal suite in milliseconds and can block a
 * merge — which is the whole point, since a judge run that needs a key cannot.
 *
 * The rules are deliberately narrow. Each one names a regression that has a
 * concrete failure story, and each returns the offending excerpt so a red run
 * reads as a diff rather than as "tone check failed".
 */

/** One rule violation, with enough context to fix it without re-deriving. */
export interface ToneViolation {
  /** Stable rule id — the test reports it, so keep it greppable. */
  rule: string;
  /** What went wrong, in one line. */
  detail: string;
  /** The offending excerpt, when the rule found one. */
  excerpt?: string;
}

/**
 * Words that flip an instruction's polarity.
 *
 * The shared prompts talk ABOUT the value-first failure mode in order to ban
 * it — "do NOT always open with the number", "never lead with the value",
 * "führe nie mit dem Wert". A naive substring scan for the banned instruction
 * would fire on the ban itself, so every candidate match is tested for a
 * negator immediately before it.
 */
const NEGATORS =
  /\b(not|never|no|non|rather than|instead of|nicht|nie|niemals|kein(e|en|em|er)?|statt|anstatt)\b/i;

/** How far back a negator still counts as governing the match. */
const NEGATION_WINDOW = 48;

/**
 * True when `pattern` matches somewhere it is NOT governed by a preceding
 * negator. Exported because the mutation-check and the fixture tests both
 * assert on the negation handling itself — it is the load-bearing part of
 * every banned-instruction rule.
 */
export function hasUnnegatedMatch(text: string, pattern: RegExp): boolean {
  return findUnnegatedMatch(text, pattern) !== null;
}

export function findUnnegatedMatch(
  text: string,
  pattern: RegExp,
): string | null {
  const scan = new RegExp(
    pattern.source,
    pattern.flags.replace(/g/g, "") + "g",
  );
  for (const m of text.matchAll(scan)) {
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - NEGATION_WINDOW), start);
    if (NEGATORS.test(before)) continue;
    return text.slice(Math.max(0, start - 24), start + m[0].length + 24);
  }
  return null;
}

/**
 * Instructions that put the NUMBER first.
 *
 * This is the exact class the biomarker card shipped for eight releases
 * ("state the current value and how it sits against the reference range"),
 * while every sibling card had already been moved to meaning-first. A prompt
 * edit that reintroduces any of these — in either instruction body — is the
 * regression this list exists to stop.
 */
export const VALUE_FIRST_INSTRUCTIONS: readonly {
  id: string;
  pattern: RegExp;
}[] = [
  { id: "en/state-the-current-value", pattern: /state the current value/i },
  {
    id: "en/name-the-value-first",
    pattern: /name the (?:current )?value first/i,
  },
  {
    id: "en/open-with-the-number",
    pattern:
      /(?:open|lead|start|begin)(?:s|ing)? with the (?:number|value|reading|figure)/i,
  },
  { id: "de/nenne-den-aktuellen-wert", pattern: /nenne den aktuellen Wert/i },
  {
    id: "de/mit-der-zahl-eroeffnen",
    pattern:
      /(?:eröffne|führe|beginne|starte)(?:st)? mit (?:der Zahl|dem Wert|dem Messwert)/i,
  },
];

/**
 * The meaning-first opening every assessment USER prompt has to carry.
 *
 * Two halves, both required, because either alone is satisfiable by accident:
 * the surface must tell the model to open on the read in plain words, AND it
 * must say the number is not what opens. The family phrases both consistently
 * ("Open with what it MEANS in plain words — the read, not the number"), so
 * matching the shared shape also keeps a new surface from inventing its own
 * dialect for the same instruction.
 */
const MEANING_FIRST_OPENER = {
  en: /\bOpen with\b[^.]{0,200}\bin plain words\b/,
  de: /\bBeginne mit\b[^.]{0,200}\bin klaren Worten\b/,
} as const;

const NUMBER_DEFERRED = {
  en: /\bnot (?:the|a) number\b/i,
  de: /\bnicht (?:der Zahl|mit einer Zahl|dem Wert)\b/i,
} as const;

/** German-only vocabulary — a leak here means a locale collapsed to the DE body. */
export const GERMAN_BODY_SENTINEL =
  /AUSGABEFORMAT|Antworte ausschließlich|Schreibe eine kurze Einschätzung|DEINE DATENGRUNDLAGE|SO BAUST DU|TONALITÄT|ERÖFFNUNG —/;

/**
 * Grade one assembled surface.
 *
 * `instructionBody` is which reviewed body the locale composes (de for German
 * readers, en for everyone else) — the meaning-first assertions key off that,
 * not off the reader's locale, because a French prompt carries the ENGLISH
 * instruction text plus a French output directive.
 */
export function checkPromptToneContract(input: {
  systemPrompt: string;
  userPrompt: string;
  instructionBody: "en" | "de";
  /** The shared opening-shape fragment the system prompt must carry. */
  openingShapeFragment: string;
}): ToneViolation[] {
  const violations: ToneViolation[] = [];
  const { systemPrompt, userPrompt, instructionBody } = input;
  const both = `${systemPrompt}\n${userPrompt}`;

  // 1. The shared opening-shape contract has to be present verbatim. A surface
  // that builds its system prompt inline instead of composing the shared base
  // loses it silently — which is exactly how the biomarker card drifted.
  if (!systemPrompt.includes(input.openingShapeFragment)) {
    violations.push({
      rule: "opening-shape-contract-present",
      detail:
        "system prompt does not carry the shared openingShape contract — it is not composing the shared base body",
    });
  }

  // 2. The user prompt has to instruct a meaning-first opening.
  if (!MEANING_FIRST_OPENER[instructionBody].test(userPrompt)) {
    violations.push({
      rule: "user-prompt-leads-with-meaning",
      detail: `user prompt has no meaning-first opener instruction (expected ${MEANING_FIRST_OPENER[instructionBody]})`,
    });
  }
  if (!NUMBER_DEFERRED[instructionBody].test(userPrompt)) {
    violations.push({
      rule: "user-prompt-defers-the-number",
      detail: `user prompt does not say the number is not what opens (expected ${NUMBER_DEFERRED[instructionBody]})`,
    });
  }

  // 3. No value-first instruction anywhere in the assembled pair.
  for (const banned of VALUE_FIRST_INSTRUCTIONS) {
    const hit = findUnnegatedMatch(both, banned.pattern);
    if (hit) {
      violations.push({
        rule: `no-value-first-instruction:${banned.id}`,
        detail: "an un-negated value-first instruction is back in the prompt",
        excerpt: hit,
      });
    }
  }

  return violations;
}

/**
 * Locale integrity for one system prompt.
 *
 * The failure this pins: for four releases the assessment path composed
 * `locale === "en" ? "en" : "de"`, so a French, Spanish, Italian or Polish
 * reader received the GERMAN instruction body — whose output clause asks for
 * German prose — with nothing anywhere telling the model to reply in the
 * reader's language. It is invisible to every English and German test.
 */
export function checkLocaleIntegrity(input: {
  systemPrompt: string;
  /** Non-empty for the four locales that ride the English body. */
  directive: string;
  /** English name of the reader's language, e.g. "French". */
  languageName: string;
}): ToneViolation[] {
  const violations: ToneViolation[] = [];

  if (input.directive.length === 0) {
    violations.push({
      rule: "locale-directive-resolves",
      detail: "no output-language directive resolved for a rider locale",
    });
  } else if (!input.systemPrompt.includes(input.directive)) {
    violations.push({
      rule: "locale-directive-present",
      detail:
        "system prompt does not carry the reader's output-language directive",
    });
  }

  if (!input.systemPrompt.includes(input.languageName)) {
    violations.push({
      rule: "locale-language-named",
      detail: `system prompt never names the reply language (${input.languageName}) — the output clause collapsed`,
    });
  }

  const german = GERMAN_BODY_SENTINEL.exec(input.systemPrompt);
  if (german) {
    violations.push({
      rule: "locale-no-german-body-leak",
      detail:
        "a rider locale composed the GERMAN instruction body — the six-locale collapse is back",
      excerpt: german[0],
    });
  }

  return violations;
}

// ── deterministic fallback tone ─────────────────────────────────────────────

/** Praise that the numbers did not earn. */
const FALSE_CHEER =
  /\b(great job|well done|amazing|fantastic|excellent|awesome|congratulations|keep it up|don't worry)\b|\b(super gemacht|toll gemacht|großartig|fantastisch|hervorragend|weiter so|keine sorge)\b/i;

/** Verdict vocabulary a non-diagnostic surface may never use. */
const CLINICAL_VERDICT =
  /\b(diagnos\w*|abnormal|patholog\w*|you (?:have|suffer from)|risk score|clinically significant)\b|\b(Diagnose|krankhaft|pathologisch|du (?:hast|leidest)|behandlungsbedürftig)\b/i;

/** The value-led opener §10 bans: "Your <metric> is <number>…". */
const VALUE_LED_OPENER =
  /^(Your|Dein|Deine|Ihr|Ihre)\s+\S+(\s+\S+)?\s+(is|ist|liegt)\s+\d/i;

function firstSentence(text: string): string {
  const m = /^[^.!?]*[.!?]/.exec(text.trim());
  return (m ? m[0] : text.trim()).trim();
}

/**
 * Grade one rendered deterministic fallback.
 *
 * `expectMeaningFirst` is false for exactly one honest case: a signal with no
 * baseline and no usable delta supports NO confident read, so the line opens
 * on the value rather than manufacturing a verdict. Pinning that asymmetry is
 * the point — "always lead with meaning" would push this surface into claiming
 * something the data does not support, which is the failure mode on the other
 * side of the same rule.
 */
export function checkFallbackTone(input: {
  text: string;
  expectMeaningFirst: boolean;
}): ToneViolation[] {
  const violations: ToneViolation[] = [];
  const text = input.text.trim();
  const opener = firstSentence(text);

  if (text.length === 0) {
    return [{ rule: "fallback-non-empty", detail: "fallback rendered empty" }];
  }

  if (input.expectMeaningFirst) {
    if (/\d/.test(opener)) {
      violations.push({
        rule: "fallback-leads-with-meaning",
        detail:
          "the opening sentence carries a figure — the deterministic line opens on a value instead of the read",
        excerpt: opener,
      });
    }
    if (VALUE_LED_OPENER.test(opener)) {
      violations.push({
        rule: "fallback-no-value-led-opener",
        detail: "opening matches the banned value-led opener shape",
        excerpt: opener,
      });
    }
  }

  const cheer = FALSE_CHEER.exec(text);
  if (cheer) {
    violations.push({
      rule: "fallback-no-false-cheer",
      detail: "praise the numbers did not earn",
      excerpt: cheer[0],
    });
  }

  const verdict = CLINICAL_VERDICT.exec(text);
  if (verdict) {
    violations.push({
      rule: "fallback-no-clinical-verdict",
      detail: "a non-diagnostic surface used verdict vocabulary",
      excerpt: verdict[0],
    });
  }

  if (/!/.test(text)) {
    violations.push({
      rule: "fallback-no-exclamation",
      detail: "exclamation mark — the assessment voice never exclaims",
    });
  }

  return violations;
}

/** Render violations as a readable multi-line failure message. */
export function formatViolations(
  label: string,
  violations: readonly ToneViolation[],
): string {
  return [
    `${label} — ${violations.length} tone violation(s):`,
    ...violations.map(
      (v) =>
        `  · [${v.rule}] ${v.detail}${v.excerpt ? `\n      …${v.excerpt}…` : ""}`,
    ),
  ].join("\n");
}
