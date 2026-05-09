import type { AIInsightResponse } from "./schema";

/**
 * v1.4.16 phase B5a — citation-coverage post-validation.
 *
 * After the schema parse + cross-citation check pass, the wrapper
 * counts how many recommendations make a normative claim
 * ("target", "should", "normal range", "above", "below") and how
 * many of those carry a `referenceId` pointing into the curated
 * medical-reference bundle. The result lands as a Wide-Event meta
 * annotation so the admin AI quality dashboard can track coverage
 * over time.
 *
 * The check is observational only — a normative rec without a
 * referenceId is logged as a warning, never raised as a parse
 * failure. v1.4.16 phase B5c flips it to required for severity
 * >= "important".
 *
 * Heuristic policy: substring match against a small fixed keyword
 * list. Locale-agnostic for v1.4.16; phase B5c may swap in a tagged
 * model output ("rec.kind: normative | observational").
 */

const NORMATIVE_KEYWORDS_EN = [
  "target",
  "should",
  "normal range",
  "above",
  "below",
];

const NORMATIVE_KEYWORDS_DE = [
  "ziel",
  "sollte",
  "normalbereich",
  "über",
  "unter",
];

const NORMATIVE_KEYWORDS = [...NORMATIVE_KEYWORDS_EN, ...NORMATIVE_KEYWORDS_DE];

/**
 * Returns true when the rec text contains a normative-claim keyword.
 * Case-insensitive substring match; no word-boundary check because
 * the keywords are common-English/-German fragments and the LLM
 * sometimes inflects them ("targets", "should be" all hit).
 */
export function detectsNormativeClaim(text: string): boolean {
  const lower = text.toLowerCase();
  return NORMATIVE_KEYWORDS.some((kw) => lower.includes(kw));
}

export interface CitationCoverage {
  /** Total `recommendations[]` length. */
  totalRecommendations: number;
  /** Subset of recs that make a normative claim. */
  normativeRecommendations: number;
  /** Subset of normative recs that carry a `referenceId`. */
  citedNormativeRecommendations: number;
  /** Recommendation ids that are normative but lack a referenceId. */
  uncitedNormativeRecommendationIds: string[];
}

/**
 * Compute the citation-coverage breakdown for a parsed insight
 * response. Pure function — no side effects, safe to unit test in
 * isolation. The wrapper at `generate-insight.ts` calls this once on
 * the successful parse and forwards the result via `annotate()`.
 */
export function computeCitationCoverage(
  parsed: AIInsightResponse,
): CitationCoverage {
  const total = parsed.recommendations.length;
  let normative = 0;
  let cited = 0;
  const uncitedIds: string[] = [];

  for (const rec of parsed.recommendations) {
    if (!detectsNormativeClaim(rec.text)) continue;
    normative += 1;
    if (rec.referenceId) {
      cited += 1;
    } else {
      uncitedIds.push(rec.id);
    }
  }

  return {
    totalRecommendations: total,
    normativeRecommendations: normative,
    citedNormativeRecommendations: cited,
    uncitedNormativeRecommendationIds: uncitedIds,
  };
}
