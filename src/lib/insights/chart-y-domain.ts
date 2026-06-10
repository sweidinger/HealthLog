/**
 * Shared Y-axis domain computation for every chart surface (dashboard
 * charts, insights sub-page charts, mini charts). One source of truth so
 * the padding rules cannot drift per chart.
 *
 * Padding rules:
 * - Flat series (min === max): pad symmetrically by 5% of the magnitude
 *   (at least 1 unit), with a little extra headroom on top.
 * - Otherwise: pad the bottom by 8% of the span (min 0.5) and the top by
 *   16% of the span (min 1).
 * - Zero clamp: when the series contains no negative values the lower
 *   bound never dips below 0 — padding only extends upward or down to 0.
 *   Counts, steps, weights etc. must not render a negative axis. Series
 *   with genuine negative values (deltas, differences) keep the full
 *   downward padding.
 */
export function computePaddedYDomain(
  values: readonly number[],
): [number, number] | undefined {
  const finite = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  if (!finite.length) return undefined;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  // Non-negative series never get a negative lower bound.
  const clampLower = (lower: number) => (min >= 0 ? Math.max(0, lower) : lower);

  if (min === max) {
    const delta = Math.max(Math.abs(min) * 0.05, 1);
    return [clampLower(min - delta), max + delta * 1.35];
  }

  const span = max - min;
  const paddingBottom = Math.max(span * 0.08, 0.5);
  const paddingTop = Math.max(span * 0.16, 1);
  return [clampLower(min - paddingBottom), max + paddingTop];
}
