/**
 * v1.20.1 — pure decision behind the charts' one-shot `onDataReady`
 * notify.
 *
 * The dashboard's shared reveal gate (`useDashboardChartReveal`) listens
 * for each chart reporting its data query settled. Every chart receives
 * an inline `() => markChartReady(id)` closure from the dashboard, so the
 * `onDataReady` prop is a NEW reference on every parent render. Keying the
 * notify effect on that prop re-ran it on every commit — and a refetch on
 * tab-resume (`refetchOnWindowFocus`) re-rendered the page repeatedly,
 * which kept that per-commit passive effect firing and the chart row's
 * Radix-Popper anchors re-committing until React tripped its update-depth
 * guard (the minified React error #185 a user reported on returning to a
 * backgrounded tab).
 *
 * The ready signal is monotonic: once a chart's initial query has settled
 * it never un-settles (a later range-tab change opens a fresh cache entry,
 * but the gate has long latched by then). So the notify must fire exactly
 * once — on the first non-loading commit — and never again, regardless of
 * the `onDataReady` prop identity.
 *
 * This helper is the pure core of that latch, exported so the gate has
 * direct unit coverage without mounting React (project convention:
 * SSR-only tests, no DOM runner). The chart wires it to a `useRef` flag.
 */
export function shouldFireDataReady(input: {
  /** The chart's query is still on its initial load. */
  isLoading: boolean;
  /** Whether the notify has already fired this mount. */
  alreadyFired: boolean;
}): boolean {
  if (input.isLoading) return false;
  if (input.alreadyFired) return false;
  return true;
}
