/**
 * Compute a 7-day trend delta from a metric summary.
 *
 * Backstory — v1.4.15 Fix 4 ("7-Tage-Schnitt" → "7-Tage-Trend"):
 * the dashboard tiles labelled the 7-day average as "7T:" / "7d:"
 * with the mean value beside it. Marc found that label unclear
 * (sounded like an "average") when the goal of the tile is to
 * convey *direction* over the past week. We re-use the existing
 * 7-day linear-regression slope (already in `DataSummary.slope7`)
 * and project a stable end-to-end delta as
 *
 *   delta = slope.slope * 7  // units per day → unit delta over 7d
 *
 * The trend-card then paints the delta with metric-aware sentiment
 * colour (up-good vs up-bad).  Returning `null` when slope7 is not
 * available keeps the tile rendering the legacy avg label for back-
 * compat with call sites that haven't been migrated.
 *
 * Pure & deterministic — pinned by unit test.
 */
import type { TrendSlope } from "@/lib/analytics/trends";

export interface TrendCapableSummary {
  slope7: TrendSlope | null;
}

export function summaryToTrend7Delta(
  summary: TrendCapableSummary | undefined | null,
): number | null {
  const slope7 = summary?.slope7;
  if (!slope7) return null;
  // slope.slope is units per day (see lib/analytics/trends.ts) → 7 days
  // is the projected end-to-end delta of the regression line.
  return slope7.slope * 7;
}
