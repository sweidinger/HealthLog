/**
 * Tiny helper for chart wrappers that need to respect
 * `prefers-reduced-motion` (v1.4.16 B1a).
 *
 * SSR-safe: returns `false` (i.e. animations *enabled*) whenever
 * `window.matchMedia` is unavailable. The chart wrappers consume this
 * during render and pass the negation to Recharts' `isAnimationActive`
 * prop so first-render line-draw animations are suppressed for users
 * who've requested reduced motion at the OS level.
 *
 * Pure / no-side-effects so the unit test runs under the default
 * vitest "node" environment.
 */
export function prefersReducedMotion(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // matchMedia can throw on legacy mobile browsers when the query
    // string is unrecognised — fall back to "no, animate".
    return false;
  }
}
