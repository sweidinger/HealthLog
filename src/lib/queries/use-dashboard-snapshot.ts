"use client";

/**
 * v1.7.0 W6 — unified dashboard first-paint snapshot hook.
 *
 * One client cell against `GET /api/dashboard/snapshot` that hydrates
 * every above-the-fold tile, replacing the legacy four-cell waterfall
 * (slim analytics + thick analytics + mood + widget layout). Three
 * properties matter:
 *
 *   - It is NOT gated on `isAuthenticated`. The server `requireAuth()`
 *     is the real gate (401 on a missing cookie); on the dashboard
 *     route the cookie is always present because `src/proxy.ts` has
 *     already passed the auth / onboarding redirect. Firing un-gated
 *     removes the `/api/auth/me` round-trip from the cold critical path
 *     (R-firstpaint §1a — the single biggest first-byte win).
 *   - `staleTime: 60_000` + `refetchOnMount: false` keep a
 *     return-to-dashboard within a minute a free cache hit.
 *   - `refetchOnWindowFocus: true` (v1.18.9) closes the background-sync
 *     freshness gap behind #38: a Withings / Apple-Health / iOS batch
 *     sync writes the user's data with NO client-side mutation event, so
 *     the snapshot keys are never invalidated and the dashboard only
 *     updated on the 120 s poll or a hard reload. Refetch-on-focus means
 *     returning to the tab after a sync surfaces the new readings within
 *     a frame. The `staleTime: 60_000` gate makes rapid focus toggles
 *     cheap (a refetch fires only once the slot is stale), and the warm
 *     server SWR cache (~180 s fresh TTL, `DASHBOARD_REFETCH_INTERVAL_MS
 *     + 60_000`) keeps the focus refetch sub-cost.
 *   - `refetchInterval: 120_000` + `refetchIntervalInBackground: false`
 *     keep an open dashboard live: an idle tab polls the snapshot every
 *     two minutes so freshly-synced Withings / HealthKit readings appear
 *     without a manual reload. The poll hits the warm ~180 s server cache
 *     cheaply and only triggers a sub-second rollup rebuild when the
 *     underlying data actually changed — never the LLM surfaces, which
 *     stay daily / pre-generated. The interval pauses while the tab is
 *     backgrounded.
 *   - The queryKey is the centralised factory entry
 *     `queryKeys.dashboardSnapshot()`.
 */
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { retryOnceOnTransientError } from "@/lib/queries/retry-transient";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  // Routed through the typed wrapper so a failure carries its HTTP
  // status (`ApiError`) for the transient-retry predicate, and the
  // default 15 s timeout keeps a stalled response from pinning the
  // whole dashboard on its skeleton.
  return apiGet<DashboardSnapshot>("/api/dashboard/snapshot");
}

/** Handoff freshness window — mirrors the hook's `staleTime`. */
const PRELOAD_MAX_AGE_MS = 60_000;

/**
 * Module-level promise handoff between the preloader and the mounted
 * hook. Deliberately OUTSIDE the query cache: writing the response into
 * the cache before the dashboard page hydrates (what `prefetchQuery`
 * did) makes the page's first client render paint tiles where the
 * server HTML painted the skeleton — a React #418 hydration mismatch
 * whenever the response beats the page chunk (fast LAN, e2e route
 * mocks). The handoff keeps the request in flight while hydration runs
 * and lets the mounted cell commit the data itself, post-hydration.
 */
let preloadedSnapshot: {
  promise: Promise<DashboardSnapshot>;
  startedAt: number;
} | null = null;

export function _resetDashboardSnapshotPreloadForTests(): void {
  preloadedSnapshot = null;
}

/**
 * Kick the snapshot fetch off ahead of the dashboard page chunk.
 *
 * v1.16.6 first-load waterfall fix: under a realistic RTT the
 * `useDashboardSnapshot` cell only fires once the dashboard page chunk
 * has downloaded, parsed, and mounted — measured at ~450 ms after the
 * navigation commits (4G / 4x-CPU profile). The route-level preloader in
 * `providers.tsx` and the login submit handler call this the moment the
 * destination is known, so the request rides in parallel with the chunk
 * download instead of behind it. The response parks in the module-level
 * handoff (NOT the query cache — see above) until the mounted cell's
 * `queryFn` consumes it; preload errors are swallowed by design — the
 * mounted cell owns error surfacing with its own fresh attempt.
 */
export function prefetchDashboardSnapshot(queryClient: QueryClient) {
  // Expired handoff from a previous visit — drop it so a long-idle slot
  // can never serve stale data.
  if (
    preloadedSnapshot &&
    Date.now() - preloadedSnapshot.startedAt >= PRELOAD_MAX_AGE_MS
  ) {
    preloadedSnapshot = null;
  }
  // A fresh handoff is already in flight / parked.
  if (preloadedSnapshot) return;
  // Cache already warm (return-to-dashboard within staleTime) — the
  // mounted cell serves it without ever calling `queryFn`; fetching here
  // would be a wasted request parked in the slot.
  const state = queryClient.getQueryState(queryKeys.dashboardSnapshot());
  if (
    state?.data !== undefined &&
    Date.now() - state.dataUpdatedAt < PRELOAD_MAX_AGE_MS
  ) {
    return;
  }
  const promise = fetchDashboardSnapshot();
  promise.catch(() => {
    // Swallow + clear so an unconsumed failed preload (racing 401 on
    // login, transient network) never becomes an unhandled rejection and
    // never gets handed to a later mount.
    if (preloadedSnapshot?.promise === promise) preloadedSnapshot = null;
  });
  preloadedSnapshot = { promise, startedAt: Date.now() };
}

/** Single-use consume of the preload handoff; `null` when absent/expired. */
function takePreloadedSnapshot(): Promise<DashboardSnapshot> | null {
  if (!preloadedSnapshot) return null;
  const { promise, startedAt } = preloadedSnapshot;
  preloadedSnapshot = null;
  return Date.now() - startedAt < PRELOAD_MAX_AGE_MS ? promise : null;
}

function makeSnapshotQueryFn(queryClient: QueryClient) {
  return async () => {
    const preloaded = takePreloadedSnapshot();
    let snap: DashboardSnapshot;
    if (preloaded) {
      try {
        snap = await preloaded;
      } catch {
        // Preload failed — this cell still owns a fresh attempt so a
        // transient prefetch error never surfaces as the query error.
        snap = await fetchDashboardSnapshot();
      }
    } else {
      snap = await fetchDashboardSnapshot();
    }
    // Cold-start de-waterfall: the snapshot already carries the
    // resolved widget layout, and the per-chart overlay-prefs hook
    // (`use-chart-overlay-prefs.ts`) fetches the SAME payload from
    // `/api/dashboard/widgets` under `queryKeys.dashboardWidgets()`
    // before the chart cells issue their measurement queries. Seeding
    // that cache here removes one full request stage from the
    // dashboard waterfall (snapshot → widgets → measurements becomes
    // snapshot → measurements). Seed ONLY when the slot is empty so a
    // later interval refetch never clobbers an optimistic overlay /
    // compare-toggle mutation that wrote the key in the meantime.
    if (!queryClient.getQueryData(queryKeys.dashboardWidgets())) {
      queryClient.setQueryData(queryKeys.dashboardWidgets(), snap.layout);
    }
    return snap;
  };
}

export function useDashboardSnapshot(enabled = true) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.dashboardSnapshot(),
    queryFn: makeSnapshotQueryFn(queryClient),
    enabled,
    staleTime: 60_000,
    refetchOnMount: false,
    // v1.18.9 (#38) — refetch on focus so a background sync (Withings /
    // Apple Health / iOS batch), which produces no client mutation event,
    // surfaces on return-to-tab. Gated by the 60 s `staleTime` above so a
    // rapid focus toggle within the window is still a free cache hit.
    refetchOnWindowFocus: true,
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // v1.16.8 — one retry on network errors / 5xx (never 401/403). A
    // single transient failure used to flash the full-dashboard empty
    // state under the former `retry: false`.
    retry: retryOnceOnTransientError,
  });
}
