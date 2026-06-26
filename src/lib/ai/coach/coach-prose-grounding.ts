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
  for (const payload of toolPayloads)
    collectNumericLeaves(payload, authoritative);
  // No authoritative figures (a qualitative turn / no-tools path) — nothing to
  // grade against. The prompt-level grounding rule remains the backstop.
  if (authoritative.size === 0) return [];

  const findings: UnverifiedCoachNumber[] = [];
  for (const { value, raw } of extractNumbers(prose)) {
    if (isStructural(value, raw)) continue;
    if (isGrounded(value, authoritative)) continue;
    findings.push({ value, source: raw.slice(0, 32) });
  }
  return findings;
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
