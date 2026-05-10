/**
 * v1.4.16 phase B5c — shared chart-mini window vocabulary.
 *
 * The Oura-style RecommendationCard (B5c) embeds a mini-chart that
 * pins to the recommendation's `rationale.dataWindow`. This helper
 * maps the rationale enum onto the per-points range used by the
 * existing chart wrappers.
 *
 *   last7days  → 7 points
 *   last30days → 30 points
 *   last90days → 90 points
 *   allTime    → 0 (HealthChart treats 0 as "no slice — show all")
 *
 * The values mirror the existing `TIME_RANGES_KEYS` definition in
 * `health-chart.tsx`; the helper is a pure function so unit tests
 * pin the contract without depending on Recharts internals.
 */

export type DataWindow = "last7days" | "last30days" | "last90days" | "allTime";

const POINTS_BY_WINDOW: Record<DataWindow, number> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  allTime: 0,
};

/**
 * Returns the per-points range value the chart wrapper expects for a
 * given rationale dataWindow enum value.
 */
export function resolveMiniRangePoints(window: DataWindow): number {
  return POINTS_BY_WINDOW[window];
}
