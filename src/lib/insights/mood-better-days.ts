/**
 * The unified "what's associated with your better days" board (F2):
 * folds the F1 tag-influence rows and the mood × health-metric
 * correlations into one effect-size-ranked, confidence-gated,
 * observational list.
 *
 * Extracted verbatim from `mood-aggregates.ts`, which re-exports this
 * module so every existing call site keeps importing from the hub.
 * Pure functions over already-computed aggregate shapes.
 */

import type { CorrelationResult } from "@/lib/analytics/correlations";
import type {
  CorrelationKey,
  MoodMetricCorrelation,
} from "@/lib/insights/mood-aggregates";
import type {
  InfluenceConfidence,
  TagInfluence,
} from "@/lib/insights/mood-tag-influence";

// --- "What's associated with your better days" board (F2) ---

/**
 * One ranked factor on the unified board. Either a tag (`source: "tag"`,
 * effect = the mood-point delta) or a health-metric correlation
 * (`source: "metric"`, effect = Pearson r). Direction tells the UI whether
 * the factor goes with higher or lower mood; the standing "association, not
 * cause" caption is rendered once for the whole board.
 */
export interface BetterDayFactor {
  source: "tag" | "metric";
  /** Tag key OR correlation channel key (sleep/steps/pulse/weight/bp). */
  key: string;
  /** Flat tags / metrics: null. Structured tags: the i18n label key. */
  labelKey: string | null;
  /** Decrypted custom-tag label; null for catalogue / flat / metric rows. */
  label?: string | null;
  categoryKey: string | null;
  icon: string | null;
  /** "up" = associated with higher mood; "down" = with lower mood. */
  direction: "up" | "down";
  /** Sample count behind the factor (tag: smaller group; metric: paired n). */
  n: number;
  /** Discrete confidence band. */
  confidence: InfluenceConfidence;
  /**
   * Unified ranking strength in [0,1]. For metrics this is |r|; for tags it
   * is min(1, |delta| / 2) — a two-point mood swing reads as full strength.
   * Ranking only; the UI surfaces the raw delta / r, not this number.
   */
  effectSize: number;
  /** Raw mood-point delta for a tag factor; null for a metric factor. */
  delta: number | null;
  /** Raw Pearson r for a metric factor; null for a tag factor. */
  r: number | null;
}

/** Max factors on the board so the headline surface stays scannable. */
export const BETTER_DAYS_MAX_FACTORS = 8;

/** Map a metric correlation strength label to the shared confidence band. */
function metricConfidence(
  strength: CorrelationResult["strength"],
): InfluenceConfidence {
  if (strength === "stark") return "high";
  if (strength === "moderat") return "medium";
  return "low";
}

/**
 * Merge the F1 tag influence rows and the mood × health-metric
 * correlations into one effect-size-ranked, confidence-gated board.
 *
 * Inclusion gates (multiple-comparison aware):
 *  - Tag rows: already gated by `computeTagInfluence` (sample floors +
 *    Welch); included as-is.
 *  - Metric rows: only correlations that reached `n ≥ 5` AND carry a
 *    non-"keine" strength (|r| ≥ 0.2) are folded in — a near-zero r is not
 *    an association.
 *
 * Ranking is by `effectSize` desc, then confidence, then key for stability.
 * The two sources are put on one comparable scale: metric rows use |r|
 * (already unitless in [0,1]); tag rows use a standardized effect — the raw
 * mood-point `delta` divided by the pooled with/without mood SD (Cohen's d),
 * clamped to [0,1]. A |d| ≥ 1 (a mean shift of one full SD) saturates the
 * scale, mirroring an |r| near its ceiling, so neither source dominates the
 * board for scale reasons alone. When a tag has no pooled SD (both groups
 * perfectly constant), it falls back to the legacy |delta|/2 heuristic — a
 * rare degenerate case that can't be standardized. The raw delta / r the UI
 * shows is unchanged; this only governs the sort order. Observational only.
 */
export function computeBetterDays(
  tagInfluence: TagInfluence,
  correlations: Record<CorrelationKey, MoodMetricCorrelation>,
): BetterDayFactor[] {
  const factors: BetterDayFactor[] = [];

  // Tag factors (both axes). Structured tags carry their label meta.
  for (const row of [...tagInfluence.structured, ...tagInfluence.flat]) {
    factors.push({
      source: "tag",
      key: row.tag,
      labelKey: row.labelKey,
      label: row.label ?? null,
      categoryKey: row.categoryKey,
      icon: row.icon,
      direction: row.delta >= 0 ? "up" : "down",
      n: Math.min(row.withDays, row.withoutDays),
      confidence: row.confidence,
      // Cohen's-d standardization so the tag effect is commensurable with a
      // metric |r|; fall back to the legacy |delta|/2 only when the pooled
      // SD is unavailable (both groups perfectly constant).
      effectSize:
        row.pooledSd && row.pooledSd > 0
          ? Math.min(1, Math.abs(row.delta) / row.pooledSd)
          : Math.min(1, Math.abs(row.delta) / 2),
      delta: row.delta,
      r: null,
    });
  }

  // Metric factors — only meaningful, sufficiently-sampled correlations.
  for (const [key, corr] of Object.entries(correlations)) {
    const result = corr.result;
    if (!result || corr.n < 5) continue;
    if (result.strength === "keine") continue;
    factors.push({
      source: "metric",
      key,
      labelKey: null,
      label: null,
      categoryKey: null,
      icon: null,
      // Mood is the x-axis: positive r = higher metric on higher-mood days,
      // i.e. the metric is associated with higher mood.
      direction: result.r >= 0 ? "up" : "down",
      n: corr.n,
      confidence: metricConfidence(result.strength),
      effectSize: Math.min(1, Math.abs(result.r)),
      delta: null,
      r: result.r,
    });
  }

  const confidenceRank: Record<InfluenceConfidence, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  return factors
    .sort(
      (a, b) =>
        b.effectSize - a.effectSize ||
        confidenceRank[b.confidence] - confidenceRank[a.confidence] ||
        a.key.localeCompare(b.key),
    )
    .slice(0, BETTER_DAYS_MAX_FACTORS);
}
