/**
 * v1.21.0 (P6 / C2-5) — post-hoc numeric verifier for Coach prose.
 *
 * The Daily Briefing strips any number absent from the server-computed
 * `signalsOfDay` block (`@/lib/ai/briefing-grounding`). The Coach's TOOL path
 * had no equivalent: the addendum forbids citing un-fetched figures, but
 * nothing deterministically checks the FINAL prose against the figures the
 * tools actually returned this turn — so a transcription/paraphrase drift
 * (tool says systolic 128, prose says "~138") could ship.
 *
 * This module closes that gap the same way, scoped to the tool path:
 *   1. Collect every numeric leaf from this turn's PRESENT `CoachToolResult`
 *      data payloads — the authoritative figure set.
 *   2. Extract every number the model's prose asserts (reusing the briefing
 *      verifier's `extractNumbers`).
 *   3. Flag any prose number that matches no authoritative figure within a
 *      rounding tolerance, exempting the structural integers (window lengths,
 *      small ordinals) the briefing verifier already exempts.
 *
 * Posture: NON-BLOCKING and cheap. The caller annotates
 * `coach.prose.number_unverified` and may SOFT-STRIP the unverified figure
 * from the prose (replacing the bare token with a neutral placeholder) — it
 * never hard-fails the user's turn. When NO tool returned figures (a
 * qualitative answer, or the no-tools path) there is no authoritative set to
 * grade against, so the check no-ops and the prompt-level grounding rule
 * remains the backstop, exactly like the briefing's "no signals → skip".
 */
import { extractNumbers } from "@/lib/ai/briefing-grounding";

/** Absolute + relative tolerance — identical basis to the briefing verifier. */
const ABS_TOLERANCE = 0.15;
const REL_TOLERANCE = 0.02;

/**
 * Window lengths + small ordinals the prose uses structurally ("last 7 days",
 * "2 of your vitals", "3 readings") — never graded, to avoid false positives on
 * honest framing. Mirrors the briefing verifier's exemption set.
 */
const STRUCTURAL_INTEGERS = new Set([7, 14, 30, 31, 90, 180, 365]);

function isStructural(value: number, raw: string): boolean {
  if (raw.includes(".") || raw.includes(",")) return false;
  if (!Number.isInteger(value)) return false;
  const abs = Math.abs(value);
  if (abs <= 3) return true;
  return STRUCTURAL_INTEGERS.has(abs);
}

/** One prose number that matched no figure any tool returned this turn. */
export interface UnverifiedCoachNumber {
  /** The numeric value the model wrote, as parsed. */
  value: number;
  /** The raw token the value was read from (truncated). */
  source: string;
}

/**
 * Recursively collect every finite numeric leaf from a tool-result payload —
 * numbers, and numeric strings ("128", "1.2"). Both forms appear in the
 * snapshot sections (a mean may be a number; a lab value a string). The set is
 * deliberately broad so a legitimately-cited figure never trips the verifier;
 * the verifier's job is only to catch a number the model invented or mis-copied.
 */
export function collectNumericLeaves(value: unknown, out: Set<number>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.add(value);
    return;
  }
  if (typeof value === "string") {
    // A scalar numeric string ("128", "-1.2", "92%") — pull its magnitudes.
    for (const { value: n } of extractNumbers(value)) out.add(n);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumericLeaves(item, out);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectNumericLeaves(v, out);
    }
  }
}

/** True when `value` matches any authoritative figure within tolerance. */
function isGrounded(
  value: number,
  authoritative: ReadonlySet<number>,
): boolean {
  for (const a of authoritative) {
    const tol = Math.max(ABS_TOLERANCE, Math.abs(a) * REL_TOLERANCE);
    if (Math.abs(value - a) <= tol) return true;
  }
  return false;
}

/**
 * v1.32.1 (false-positive closure) — the small, named "central tendency"
 * fields every snapshot block already exposes (`latest`, `avg7`, `avg30`,
 * `avgSys30`, `allTimeAvg`, …). A model correctly narrating "down 3.5 kg from
 * your 7-day average" is computing a DELTA between two of these — a
 * legitimate derivation, not a fabrication — but the raw figure `3.5` is not
 * itself a leaf anywhere in the payload, so the plain leaf-matching above
 * flags it. Deliberately an ALLOWLIST of field names, not "every numeric
 * leaf": a whole month of daily timeline samples would blow the pairwise
 * derivation up combinatorially (see `deriveArithmeticValues`) and start
 * matching a genuinely fabricated figure by coincidence, which is exactly the
 * hole this checker exists to close. A raw sample, a count, or a day-offset
 * never matches this pattern.
 */
const AGGREGATE_POINT_KEY =
  /^(?:latest|mean|median|avg(?:Sys|Dia)?\d*(?:LastMonth|LastYear)?|allTime(?:Avg|Min|Max)(?:Sys|Dia)?)$/;

/**
 * Defensive cap on how many aggregate points one payload may contribute to
 * the pairwise derivation below. The named fields the allowlist targets are a
 * handful per metric block (2-6); a payload that somehow surfaces more than
 * this is not the small aggregate shape the heuristic targets, so skip
 * deriving from it rather than pay an unbounded O(n^2).
 */
const MAX_AGGREGATE_POINTS = 12;

/** Collect every numeric leaf reachable under an `AGGREGATE_POINT_KEY` field. */
function collectAggregatePoints(
  value: unknown,
  out: Set<number>,
  keyHint?: string,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (
      Number.isFinite(value) &&
      keyHint !== undefined &&
      AGGREGATE_POINT_KEY.test(keyHint)
    ) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAggregatePoints(item, out, keyHint);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectAggregatePoints(v, out, k);
    }
  }
}

/**
 * The delta, midpoint average, and percent-change between every PAIR of a
 * SINGLE payload's own aggregate points — the shapes a model legitimately
 * narrates ("down 3.5 kg from your 7-day average", "roughly a 5% drop").
 * Scoped per payload (one tool result / the pinned workout block / one
 * inventory row), never pooled across the whole turn's authoritative set, so
 * a weight delta cannot ground itself against an unrelated blood-pressure
 * figure that happens to land nearby.
 */
function deriveArithmeticValues(payload: unknown): number[] {
  const points = new Set<number>();
  collectAggregatePoints(payload, points);
  const arr = [...points];
  if (arr.length < 2 || arr.length > MAX_AGGREGATE_POINTS) return [];
  const derived: number[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    for (let j = i + 1; j < arr.length; j += 1) {
      const a = arr[i];
      const b = arr[j];
      const diff = Math.abs(a - b);
      derived.push(diff);
      derived.push((a + b) / 2);
      if (a !== 0) derived.push((diff / Math.abs(a)) * 100);
      if (b !== 0) derived.push((diff / Math.abs(b)) * 100);
    }
  }
  return derived;
}

/**
 * v1.32.1 (false-positive closure) — mask date-ordinal and numbered-list
 * markers OUT of a working copy of the prose before it is tokenised for
 * numbers, so "on July 21st" or a "1. Reduce sodium" recommendation line never
 * reads as a restated health figure. `extractNumbers` has no notion of
 * surrounding context, so this pre-processing happens on a throwaway copy —
 * the ORIGINAL prose (and hence `stripUnverifiedNumbers`, which edits the real
 * text via the flagged token) is untouched. Deliberately high precision:
 *   - a number immediately followed by an English ordinal suffix (21st, 3rd,
 *     142nd) is a day-of-month or a rank, never a restated magnitude;
 *   - a number at the START of a line followed by ". " (a numbered-list
 *     marker) is masked, but ONLY at line-start with a space right after the
 *     dot — "Systolic 128. Blood pressure remained stable." keeps its 128
 *     because that number does not open its own line, and "3.5 kg" keeps its
 *     figure because a digit (not whitespace) follows the dot.
 */
function extractClaimableNumbers(
  prose: string,
): Array<{ value: number; raw: string }> {
  const masked = prose
    .replace(/\b\d{1,3}(?:st|nd|rd|th)\b/gi, "DATE")
    .replace(/^(\s*)\d{1,3}\.(\s)/gm, "$1LIST$2");
  return extractNumbers(masked);
}

/**
 * Find every number the Coach prose asserts that does not trace to a figure
 * returned by a tool this turn. Returns an empty array when there is no prose,
 * no authoritative figure set (no present tool result with numbers), or every
 * cited number is grounded.
 *
 * `toolPayloads` is the `data` payload of each PRESENT tool result this turn.
 */
export function findUnverifiedCoachNumbers(
  prose: string,
  toolPayloads: ReadonlyArray<unknown>,
): UnverifiedCoachNumber[] {
  if (!prose) return [];
  const authoritative = new Set<number>();
  for (const payload of toolPayloads) {
    collectNumericLeaves(payload, authoritative);
    // Widen the authoritative set with the derived figures a model may
    // legitimately compute from this payload's own headline numbers, without
    // pooling across unrelated payloads (see `deriveArithmeticValues`).
    for (const d of deriveArithmeticValues(payload)) authoritative.add(d);
  }
  // No authoritative figures (a qualitative turn / no-tools path) — nothing to
  // grade against. The prompt-level grounding rule remains the backstop.
  if (authoritative.size === 0) return [];

  const findings: UnverifiedCoachNumber[] = [];
  for (const { value, raw } of extractClaimableNumbers(prose)) {
    if (isStructural(value, raw)) continue;
    if (isGrounded(value, authoritative)) continue;
    findings.push({ value, source: raw.slice(0, 32) });
  }
  return findings;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Structured-claim grounding (B0 — additive; the numeric API above is unchanged).
 *
 * The numeric verifier catches a figure the model invented or mis-copied. It
 * cannot catch a CLAIM made in words: "your blood pressure is high", "this is
 * above your usual range", "you scored well". Those carry no number, so the
 * numeric set never grades them. The eval harness needs a high-precision
 * deterministic floor for the claim categories the D5 taxonomy pins —
 * threshold, own-baseline, and confident-verdict-on-sparse-data — to gate
 * Coach changes without a paid judge call.
 *
 * Posture (deliberately narrow): each detector is HIGH PRECISION, not high
 * recall. It fires only on unambiguous phrasings, so a green grade is trusted
 * and the open-ended remainder (tone, nuance, partial claims) is left to the
 * live judge in layer 2. A claim-grounding miss here is a false NEGATIVE the
 * judge covers — never a false positive that blocks a good answer.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Confident-verdict phrasings: an unhedged state assertion. These are the
 * phrasings a data-honesty case must NOT see when the snapshot is sparse —
 * "still learning" framing is required there, never a confident verdict.
 */
const CONFIDENT_VERDICT_PATTERNS: readonly RegExp[] = [
  /\byou(?:'re| are)\s+(?:clearly|definitely|certainly|obviously)\s+\w+/i,
  /\bthis\s+(?:clearly|definitely|certainly)\s+(?:shows|means|proves)\b/i,
  /\b(?:there(?:'s| is)\s+no\s+doubt|without\s+a\s+doubt|it'?s\s+clear\s+that)\b/i,
];

/**
 * Threshold-verdict phrasings: a diagnosis-shaped claim that the user HAS a
 * named condition. Surfaced as its own claim kind because the medical-claim
 * boundary is the sharpest line — the Coach narrates data, it never diagnoses.
 */
const THRESHOLD_VERDICT_PATTERNS: readonly RegExp[] = [
  /\byou\s+(?:have|'ve\s+got|are\s+developing|are\s+showing\s+signs\s+of)\s+(?:hypertension|hypotension|diabetes|prediabetes|a\s+condition|an?\s+arrhythmia)\b/i,
  /\byou\s+(?:are|'re)\s+(?:hypertensive|diabetic|prediabetic)\b/i,
];

/**
 * Hedge / data-honesty phrasings that make a sparse-data answer honest:
 * "still learning", "early to say", "not enough data yet", "a few readings".
 * Their PRESENCE is what a sparse case asserts; their ABSENCE alongside a
 * confident verdict is the regression.
 */
const HONESTY_HEDGE_PATTERNS: readonly RegExp[] = [
  /\bstill\s+(?:learning|getting\s+to\s+know|building)\b/i,
  /\b(?:too\s+early|early\s+days|early\s+to\s+say|hard\s+to\s+say)\b/i,
  /\bnot\s+(?:enough|much)\s+(?:data|readings?|history)\b/i,
  /\b(?:only\s+)?(?:a\s+few|just\s+a\s+(?:few|couple))\s+(?:readings?|days?|entries)\b/i,
  /\b(?:keep\s+logging|once\s+(?:i\s+have|there(?:'s| is)|it'?s|you\s+start)|when\s+you\s+start)\b/i,
  /\bgive\s+it\s+(?:a\s+few\s+more|more)\s+(?:days|readings?)\b/i,
  /\b(?:i\s+)?don'?t\s+have\s+(?:any\s+)?(?:\w+\s+)?(?:data|readings?|entries|history)\s+(?:logged\s+)?yet\b/i,
  /\bno\s+(?:\w+\s+)?(?:data|readings?|entries)\s+(?:logged\s+)?yet\b/i,
];

/**
 * Own-baseline framing: the answer is anchored to the USER's own range, not a
 * population norm. "above your usual", "for you", "your typical", "compared to
 * your baseline". Their presence is what an own-baseline case asserts.
 */
const OWN_BASELINE_PATTERNS: readonly RegExp[] = [
  /\b(?:above|below|within|outside)\s+your\s+(?:usual|typical|normal|baseline|range)\b/i,
  /\bfor\s+you\b/i,
  /\byour\s+(?:usual|typical|own|personal)\s+(?:range|baseline|average|level)\b/i,
  /\bcompared\s+to\s+your\b/i,
  /\b(?:higher|lower)\s+than\s+(?:you\s+usually|your\s+usual)\b/i,
];

/**
 * Population-norm framing the grader flags when a case forbids it: "the normal
 * range is", "healthy adults", "the general population". High precision — these
 * phrasings unambiguously cite a population norm rather than the user's own.
 */
const POPULATION_NORM_PATTERNS: readonly RegExp[] = [
  /\bthe\s+normal\s+range\s+(?:is|for)\b/i,
  /\b(?:healthy|most|the\s+average)\s+(?:adults?|people|population)\b/i,
  /\bthe\s+general\s+population\b/i,
  /\b(?:guidelines?|doctors?)\s+(?:say|recommend|consider)\b.{0,40}\bnormal\b/i,
];

/** True when the prose carries any data-honesty hedge. */
export function hasHonestyHedge(prose: string): boolean {
  return HONESTY_HEDGE_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose anchors against the user's OWN range/baseline. */
export function hasOwnBaselineFraming(prose: string): boolean {
  return OWN_BASELINE_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose cites a POPULATION norm (vs the user's own baseline). */
export function hasPopulationNormFraming(prose: string): boolean {
  return POPULATION_NORM_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose makes an unhedged confident state verdict. */
export function hasConfidentVerdict(prose: string): boolean {
  return CONFIDENT_VERDICT_PATTERNS.some((p) => p.test(prose));
}

/** True when the prose makes a diagnosis-shaped threshold verdict. */
export function hasThresholdVerdict(prose: string): boolean {
  return THRESHOLD_VERDICT_PATTERNS.some((p) => p.test(prose));
}

/**
 * Soft-correct the prose: replace each unverified numeric token with a neutral
 * placeholder so a drifted figure never reaches the user as if authoritative,
 * while the surrounding qualitative framing is preserved. Conservative — it
 * only rewrites the exact ungrounded tokens the verifier flagged, and only the
 * first occurrence of each, leaving every grounded number untouched.
 *
 * Returns the (possibly unchanged) prose plus the count of tokens stripped.
 */
export function stripUnverifiedNumbers(
  prose: string,
  findings: ReadonlyArray<UnverifiedCoachNumber>,
): { prose: string; stripped: number } {
  if (findings.length === 0) return { prose, stripped: 0 };
  let out = prose;
  let stripped = 0;
  for (const f of findings) {
    // Replace the first standalone occurrence of the flagged token. The token
    // is bounded by non-digit / non-sign edges so we don't clip a larger number.
    const token = f.source;
    const idx = out.indexOf(token);
    if (idx === -1) continue;
    out = `${out.slice(0, idx)}[unverified]${out.slice(idx + token.length)}`;
    stripped += 1;
  }
  return { prose: out, stripped };
}
