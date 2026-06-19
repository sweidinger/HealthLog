/**
 * v1.12.7 — chart-reactive metric statistics.
 *
 * When the user brushes a window in a metric sub-page chart, the
 * Min / Max / Median / Mittelwert strip recomputes over just the visible
 * domain rather than the full range. This helper is the single pure
 * computation behind that: hand it the visible per-type values and it
 * returns the four central statistics.
 *
 * The four-statistic shape matches the subset of `DataSummary` the strip
 * renders (`min` / `max` / `median` / `mean`), and the median uses the same
 * linear-interpolated midpoint definition as `summarize()` in
 * `src/lib/analytics/trends.ts` so a brushed window and the full-range
 * summary read on the same algorithm — only the window differs.
 *
 * The helper is deliberately free of any Recharts / React dependency so the
 * chart can compute windowed stats off the array it already holds without
 * re-fetching, and the unit suite can pin the maths without mounting a chart.
 */

export interface MetricWindowStats {
  /** Number of finite values in the window. */
  count: number;
  min: number | null;
  max: number | null;
  median: number | null;
  mean: number | null;
}

const EMPTY: MetricWindowStats = {
  count: 0,
  min: null,
  max: null,
  median: null,
  mean: null,
};

/**
 * Compute Min / Max / Median / Mean over a list of values. Non-finite
 * entries (NaN, Infinity, null, undefined) are dropped before the fold so a
 * sparse series with gaps still summarises cleanly. An empty (or all-gap)
 * input returns the all-null shape so the caller can fall back to the
 * full-range summary rather than paint zeros.
 */
export function computeWindowStats(
  values: Array<number | null | undefined>,
): MetricWindowStats {
  const finite: number[] = [];
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0) return { ...EMPTY };

  // Single-pass sum/min/max — mirrors the bounded fold in `summarize()`
  // so a multi-year power user's brushed window never spreads a huge
  // argument list onto the stack.
  let sum = 0;
  let min = finite[0];
  let max = finite[0];
  for (const v of finite) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / finite.length;

  // Linear-interpolated midpoint on an even-length series — the standard
  // PERCENTILE_CONT(0.5) definition, matching `summarize()`.
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return { count: finite.length, min, max, median, mean };
}
