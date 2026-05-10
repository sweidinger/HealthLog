/**
 * v1.4.19 A2 — universal X-axis tick-density helper.
 *
 * Charts on /dashboard and /insights all pre-v1.4.19 used Recharts'
 * default tick rendering with `interval="preserveStartEnd"`. That left
 * the medication compliance chart painting one tick PER DAY on a Pixel
 * 5 (393 CSS px wide) — 30 overlapping labels that became an unreadable
 * smear. The weight / BMI charts didn't show the same density because
 * they auto-bucketed daily → weekly above 90 days, but at the 30-day
 * range they still drew one tick every couple of days.
 *
 * The user-visible problem: chart cards looked inconsistent. Some had
 * dense clutter, others had clean breathing-room. This helper unifies
 * the rule across every chart so the X-axis reads the same way no
 * matter the metric.
 *
 * Strategy: cap visible ticks based on the viewport width.
 *
 *   ≤ 360px  (Galaxy Fold compact)   → 4 ticks max
 *   ≤ 480px  (Pixel 5, iPhone 12)    → 6 ticks max
 *   ≤ 768px  (small tablet)          → 8 ticks max
 *   > 768px  (desktop)               → 10 ticks max
 *
 * The Recharts `interval` prop expects a 0-based skip count: 0 = render
 * every tick, 1 = render every other, 2 = every third, etc. For N data
 * points and a target of `target` visible ticks, the interval is
 * `Math.ceil(N / target) - 1`.
 *
 * `interval="preserveStartEnd"` forces the first and last tick to be
 * rendered regardless of the modulo skip. We keep that behaviour because
 * the leftmost / rightmost dates are the most important context the
 * chart provides; losing them in the skip pattern would feel buggy.
 */

/** Sensible defaults for the four ranges Pixel 5 / iPhone / iPad / desktop. */
const VIEWPORT_BUCKETS: ReadonlyArray<{
  /** Inclusive upper bound on viewport width in CSS pixels. */
  maxWidth: number;
  /** Maximum number of x-axis ticks to render at this width. */
  maxTicks: number;
}> = [
  { maxWidth: 360, maxTicks: 4 },
  { maxWidth: 480, maxTicks: 6 },
  { maxWidth: 768, maxTicks: 8 },
  { maxWidth: Number.POSITIVE_INFINITY, maxTicks: 10 },
];

/**
 * Resolve the target number of visible ticks for a given viewport
 * width. Pure & deterministic so unit tests can pin exact values for
 * each device size.
 */
export function resolveTargetTickCount(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return VIEWPORT_BUCKETS[VIEWPORT_BUCKETS.length - 1].maxTicks;
  }
  for (const bucket of VIEWPORT_BUCKETS) {
    if (viewportWidth <= bucket.maxWidth) return bucket.maxTicks;
  }
  return VIEWPORT_BUCKETS[VIEWPORT_BUCKETS.length - 1].maxTicks;
}

/**
 * Compute the Recharts `interval` skip count for a chart with
 * `pointCount` data points rendered at `viewportWidth`.
 *
 * Returns 0 when the chart has fewer points than the target tick
 * count (no skipping needed) and a positive integer otherwise.
 *
 * Examples (Pixel 5, viewportWidth 393, maxTicks 6):
 *   - 7  points → 0   (fits in 6 slots after preserveStartEnd kicks in)
 *   - 30 points → 5   (every 6th tick → 5 visible labels + endpoints)
 *   - 90 points → 16  (every 17th tick → ~5 visible labels)
 *   - 365 points → 64 (every 65th tick → ~5 visible labels)
 */
export function chooseTickInterval(
  pointCount: number,
  viewportWidth: number,
): number {
  if (!Number.isFinite(pointCount) || pointCount <= 0) return 0;
  const target = resolveTargetTickCount(viewportWidth);
  if (pointCount <= target) return 0;
  // `Math.ceil(N/target) - 1` is the skip count that produces at most
  // `target` evenly-spaced labels. Subtract one because Recharts interval
  // 0 means "render every tick", 1 means "render every other", etc.
  return Math.max(0, Math.ceil(pointCount / target) - 1);
}

/**
 * SSR-safe accessor for the active viewport width. Used by chart wrappers
 * so they can react to the current device. Returns the desktop default
 * (1280) on the server so SSR-rendered charts keep their pre-v1.4.19
 * tick density and progressively enhance once mounted in the browser.
 */
export function getViewportWidth(): number {
  if (typeof window === "undefined") return 1280;
  // visualViewport reflects pinch-zoom on iOS; we want the layout
  // viewport, not the visual one. Fall back to innerWidth.
  return window.innerWidth ?? 1280;
}
