"use client";

import { useSyncExternalStore } from "react";

// Stable no-op subscription — the "store" never changes; only the
// server/client snapshot split below does the work.
const emptySubscribe = () => () => {};

/**
 * v1.16.4 — SSR/CSR-consistent mount flag for query-dependent chrome.
 *
 * React hydrates streamed Suspense boundaries late, so a client
 * component can hydrate AFTER a TanStack query already resolved.
 * Any first render that branches on query state (`isLoading`,
 * `isAuthenticated`, cached data) then disagrees with the
 * server-rendered HTML and React logs hydration error #418.
 *
 * `useMounted()` returns `false` during SSR AND during the hydration
 * render (React always uses the server snapshot of a
 * `useSyncExternalStore` while hydrating, regardless of when the
 * boundary hydrates), then `true` from the first client re-render.
 * Gate query-derived branches on it:
 *
 *   const mounted = useMounted();
 *   if (!mounted || query.isLoading) return <Skeleton />;
 *
 * Unlike the classic `useEffect(() => setMounted(true), [])` pattern
 * this needs no state setter inside an effect (the repo's
 * `react-hooks/set-state-in-effect` rule rejects that) and stays a
 * single re-render.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
