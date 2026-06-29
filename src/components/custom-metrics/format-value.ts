/**
 * v1.25.5 — format a custom-metric value for display.
 *
 * When the metric defines a fixed number of decimals, honour it; otherwise fall
 * back to a compact representation that trims trailing zeros (up to 3 places).
 */
export function formatMetricValue(
  value: number,
  decimals: number | null | undefined,
): string {
  if (!Number.isFinite(value)) return "—";
  if (decimals != null) {
    return value.toFixed(decimals);
  }
  // Compact default: round to at most 3 places and drop trailing zeros.
  return String(Math.round(value * 1000) / 1000);
}
