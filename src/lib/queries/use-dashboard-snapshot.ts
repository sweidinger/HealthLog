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
 *   - `staleTime: 60_000` + `refetchOnMount: false` +
 *     `refetchOnWindowFocus: false` mirror `DASHBOARD_QUERY_OPTS` so a
 *     return-to-dashboard within a minute is a free cache hit.
 *   - `refetchInterval: 120_000` + `refetchIntervalInBackground: false`
 *     keep an open dashboard live: an idle tab polls the snapshot every
 *     two minutes so freshly-synced Withings / HealthKit readings appear
 *     without a manual reload. The poll hits the warm 60 s server cache
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
import { queryKeys } from "@/lib/query-keys";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

async function fetchDashboardSnapshot(): Promise<DashboardSnapshot> {
  const res = await fetch("/api/dashboard/snapshot");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.data as DashboardSnapshot;
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
 * download instead of behind it. `prefetchQuery` dedupes against the
 * later `useQuery` mount (same key → shares the in-flight promise) and
 * swallows errors by design — the mounted cell owns error surfacing.
 */
export function prefetchDashboardSnapshot(queryClient: QueryClient) {
  void queryClient.prefetchQuery({
    queryKey: queryKeys.dashboardSnapshot(),
    queryFn: makeSnapshotQueryFn(queryClient),
    staleTime: 60_000,
    retry: false,
  });
}

function makeSnapshotQueryFn(queryClient: QueryClient) {
  return async () => {
    const snap = await fetchDashboardSnapshot();
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
    refetchOnWindowFocus: false,
    refetchInterval: DASHBOARD_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
  });
}
