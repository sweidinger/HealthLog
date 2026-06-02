/**
 * v1.9.0 — client-safe range constants and types for the Insights metric
 * pages.
 *
 * The user-selectable range list, its type, the per-range window length, and
 * the period-over-period result shapes are shared between the client (the
 * pills, the delta caption, the range hook, the layout-prefs hook) and the
 * server (`/api/analytics/range` + `range-delta.ts`). This module imports
 * NOTHING server-side — no rollup readers, no `db`, no Prisma client — so the
 * client bundle never transitively pulls `pg` (dns/fs/net/tls) through a range
 * import. The server-only window-composition logic lives in `range-delta.ts`,
 * which re-exports these names for its own callers.
 */

/** The user-selectable ranges. */
export const ANALYTICS_RANGES = ["7d", "30d", "90d", "1y"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** Trailing-window length, in days, for each range. */
const RANGE_WINDOW_DAYS: Record<AnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export function rangeWindowDays(range: AnalyticsRange): number {
  return RANGE_WINDOW_DAYS[range];
}

/** A composed window aggregate. `mean`/etc. are null when the window is empty. */
export interface WindowAggregate {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
}

export interface RangeDeltaResult {
  range: AnalyticsRange;
  windowDays: number;
  /** The granularity the underlying rollup read resolved against. */
  granularity: string;
  current: WindowAggregate;
  previous: WindowAggregate;
  /**
   * `current.mean - previous.mean`, or null when either window has no mean
   * (no data in the current or prior window) — never a misleading 0.
   */
  delta: number | null;
  /**
   * `delta / previous.mean` as a fraction (0.03 = +3 %), or null when the
   * prior window has no mean / a zero mean (no divide-by-zero, no misleading
   * 0 %). The client renders "no prior-period data" in that case.
   */
  deltaPct: number | null;
}
