/**
 * Reachability note. This module was written for `generateInsight()`, whose
 * only caller is `runWithFallback()` — and `runWithFallback()` has no
 * production caller left (every live surface routes through
 * `runRawCompletionWithFallback` instead). The coverage annotation therefore
 * never executed in production: an audit surface that implied enforcement it
 * did not perform. Rather than delete working, tested logic, the input type is
 * widened to the structural shape both payloads share and the comprehensive
 * post-parse step now calls it, so the admin quality dashboard sees real data.
 */

/**
 * The minimum recommendation shape the coverage check needs. Both the strict
 * `AIInsightResponse` and the live `InsightResult` satisfy it; the live union
 * also admits a bare string, which carries neither an id nor a citation and is
 * therefore counted as uncited when it makes a normative claim.
 */
export interface RecommendationForCoverage {
  id?: string;
  text: string;
  referenceId?: string;
  /**
   * Callers pass their own richer recommendation objects (severity, rationale,
   * metricSource, …). Only the three fields above are read; the index
   * signature keeps a wider literal assignable without a cast at every site.
   */
  [key: string]: unknown;
}

export interface PayloadForCoverage {
  recommendations: ReadonlyArray<RecommendationForCoverage | string>;
  /** Callers pass the whole payload; only `recommendations` is read. */
  [key: string]: unknown;
}

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
  parsed: PayloadForCoverage,
): CitationCoverage {
  const total = parsed.recommendations.length;
  let normative = 0;
  let cited = 0;
  const uncitedIds: string[] = [];

  for (const [index, raw] of parsed.recommendations.entries()) {
    const rec: RecommendationForCoverage =
      typeof raw === "string" ? { text: raw } : raw;
    if (!detectsNormativeClaim(rec.text)) continue;
    normative += 1;
    if (rec.referenceId) {
      cited += 1;
    } else {
      // A legacy string rec has no id of its own; index it so the dashboard
      // can still point at which entry was uncited.
      uncitedIds.push(rec.id ?? `index:${index}`);
    }
  }

  return {
    totalRecommendations: total,
    normativeRecommendations: normative,
    citedNormativeRecommendations: cited,
    uncitedNormativeRecommendationIds: uncitedIds,
  };
}
