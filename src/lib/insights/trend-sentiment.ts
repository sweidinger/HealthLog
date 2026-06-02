/**
 * v1.9.0 — shared metric-aware trend sentiment helpers.
 *
 * Extracted from `trend-card.tsx` so the range-delta caption (the time-range
 * pills feature) paints the exact same colour for the same signal as the
 * dashboard tiles. The mapping is the v1.5 phase-5 audit's: an upward move is
 * good for some metrics (mood, HRV, steps), bad for others (resting HR,
 * weight, body fat), and value-judgement-free for the rest.
 */

/**
 * Maps a metric's "up means" direction to colour sentiment.
 *
 *   - `up-good`   — higher value is better (mood, HRV, steps). ↑ green, ↓ orange.
 *   - `up-bad`    — higher value is worse (resting HR, weight, body fat).
 *                   ↑ orange, ↓ green.
 *   - `neutral`   — direction carries no value judgement (the change renders
 *                   muted).
 */
export type TrendDirectionSentiment = "up-good" | "up-bad" | "neutral";

/**
 * The resolved sentiment of a signed change under a metric's direction.
 *
 *  - `positive` — the change moves the metric toward its goal. Renders green.
 *  - `negative` — the change moves away from the goal. Renders orange.
 *  - `neutral`  — the metric's direction is neutral, or the change is below
 *    the noise floor (|change| < 0.05). Renders muted.
 */
export type TrendSentimentDirection = "positive" | "negative" | "neutral";

export function getTrendSentiment(
  change: number | null | undefined,
  sentiment: TrendDirectionSentiment,
): TrendSentimentDirection {
  if (change == null || Math.abs(change) < 0.05) return "neutral";
  if (sentiment === "neutral") return "neutral";
  const isUp = change > 0;
  const isGood =
    (sentiment === "up-good" && isUp) || (sentiment === "up-bad" && !isUp);
  return isGood ? "positive" : "negative";
}

export function sentimentColorClass(
  direction: TrendSentimentDirection,
): string {
  // Semantic tokens, not raw --dracula-*: `--success` / `--warning` alias
  // the same Dracula green/orange in dark mode (pixel-identical there) but
  // carry the AA-safe `:root.light` overrides, so the trend arrow + delta
  // clear AA on the white card instead of the ~1.2:1 the raw primitives hit.
  if (direction === "positive") return "text-success";
  if (direction === "negative") return "text-warning";
  return "text-muted-foreground";
}

/**
 * v1.9.0 — map a `MetricDirection` (the metric-status registry's
 * `higher-better` / `lower-better` / `target-band`) onto a
 * `TrendDirectionSentiment` for the range-delta caption. `target-band`
 * metrics (body temperature, respiratory rate, …) have no single good
 * direction, so a period-over-period delta carries no sentiment colour —
 * `neutral`, matching Oura's deviation framing for baseline metrics.
 */
export function sentimentFromMetricDirection(
  direction: "higher-better" | "lower-better" | "target-band",
): TrendDirectionSentiment {
  if (direction === "higher-better") return "up-good";
  if (direction === "lower-better") return "up-bad";
  return "neutral";
}
