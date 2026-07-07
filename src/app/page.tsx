import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

import { getSession } from "@/lib/auth/session";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";
import { queryKeys } from "@/lib/query-keys";

import DashboardPageClient from "./page-client";

/**
 * Thin RSC wrapper around the (client) dashboard page.
 *
 * The measured first-load gap on `/` was never the server: FCP painted the
 * SSR skeleton shell at ~1.8 s but LCP landed at ~5.5 s (mobile-throttled)
 * because the real tile content waited for the full JS download + hydrate +
 * a CLIENT-side snapshot fetch — while `/api/dashboard/snapshot` itself
 * answers in ~8 ms server-side. This wrapper runs that same cached read
 * during SSR and hands it to TanStack through `HydrationBoundary`, so the
 * first HTML already carries real tile data and the mounted snapshot cell
 * (`staleTime` 60 s, `refetchOnMount: false`) starts warm instead of
 * skeleton-first.
 *
 * Contract notes:
 *  - Query keys come ONLY from the central factory. The live cell is
 *    locale-keyed (`dashboardSnapshot(locale)`), and the locale here is the
 *    same resolution the API route uses (`resolveServerLocale`), which the
 *    client provider mirrors via the layout's `resolveInitialLocale`.
 *  - The payload is JSON-round-tripped so the hydrated shape is exactly
 *    what the client `queryFn` would produce from the wire ((await
 *    res.json()).data — Dates as ISO strings), never a Date-carrying
 *    sibling that would poison the cell for later readers.
 *  - `dashboardWidgets` is seeded alongside, mirroring the client cell's
 *    own warm-up in `use-dashboard-snapshot.ts` (the overlay-prefs hook
 *    reads it before the chart cells fire).
 *  - Fail-soft: no session (proxy is mid-redirect), a builder hiccup, or a
 *    DB blip renders the page exactly as before this wrapper existed — the
 *    client cell owns the fetch then.
 */
export default async function DashboardPage() {
  // Operator/test escape hatch: `DASHBOARD_SSR_PREFETCH=false` renders the
  // pure client-fetch dashboard (pre-prefetch behaviour). The e2e server
  // sets it so Playwright route mocks — which only see CLIENT fetches —
  // keep governing what the dashboard paints.
  if (process.env.DASHBOARD_SSR_PREFETCH === "false") {
    return <DashboardPageClient />;
  }
  let dehydratedState = null;
  try {
    const session = await getSession();
    if (session) {
      const { body, locale } = await readDashboardSnapshotCached(session.user);
      // Match the client cell's wire shape exactly (JSON semantics, ISO
      // date strings) — same-key-different-shape is silent cache poison.
      const wireBody = JSON.parse(JSON.stringify(body)) as unknown as Record<
        string,
        unknown
      >;
      const queryClient = new QueryClient();
      queryClient.setQueryData(queryKeys.dashboardSnapshot(locale), wireBody);
      queryClient.setQueryData(queryKeys.dashboardWidgets(), wireBody.layout);
      dehydratedState = dehydrate(queryClient);
    }
  } catch {
    // Prefetch is an accelerator, never a gate — the client path stands.
  }

  if (dehydratedState === null) {
    return <DashboardPageClient />;
  }
  return (
    <HydrationBoundary state={dehydratedState}>
      <DashboardPageClient />
    </HydrationBoundary>
  );
}
