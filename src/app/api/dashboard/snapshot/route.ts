/**
 * GET /api/dashboard/snapshot
 *
 * v1.7.0 W6 — unified above-the-fold first-paint payload for the web
 * dashboard. One `apiHandler`-wrapped GET that assembles every tile
 * field in a single round-trip via `buildDashboardSnapshot` so the
 * whole strip shares one completion moment instead of the legacy
 * four-cell waterfall (slim analytics + thick analytics + mood + widget
 * layout, each gated behind `/api/auth/me`).
 *
 * Cookie OR Bearer auth via `requireAuth()`; the dashboard is a
 * cookie-session surface but the route does not gate on it. `userId`
 * is narrowed from the resolved session — never a body field.
 *
 * The body is read-through `caches.analytics` (stale-while-revalidate
 * via `cachedSwr`) keyed `${userId}|dashboard-snapshot`, with a per-key
 * TTL of `SNAPSHOT_CACHE_TTL_MS` (>= the client's 120 s refetch
 * interval) so a scheduled refetch lands on a warm entry instead of
 * re-running the full builder on every tick. It still rides the
 * analytics bucket so a measurement / mood / medication write covers it
 * (see `src/lib/cache/invalidate.ts`): a measurement write marks the
 * bucket stale (the high-frequency iOS-sync path serves the prior
 * snapshot + warms a background recompute), while a widget reorder still
 * hard-evicts so the layout change paints synchronously. Per-sub-query
 * timings surface under `meta.snapshot.sub_*_ms` on the cache-miss path
 * so a regression is attributable without re-instrumenting.
 *
 * No LLM is reachable from the builder — the daily briefing is lifted
 * read-only from `User.insightsCachedText`. The nightly
 * `insight-pregenerate` cron keeps that cache warm.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { readDashboardSnapshotCached } from "@/lib/dashboard/snapshot-read";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dashboard.snapshot" } });

  const timings: Record<string, number> = {};
  const time = async <T>(
    label: string,
    builder: () => Promise<T>,
  ): Promise<T> => {
    const t0 = Date.now();
    const result = await builder();
    timings[`snapshot.sub_${label}_ms`] = Date.now() - t0;
    return result;
  };

  // The cached read (user-row mapping, locale resolution, SWR cell) is
  // shared with the dashboard RSC prefetch — see
  // `src/lib/dashboard/snapshot-read.ts` for the cache-key/TTL contract.
  const { body } = await readDashboardSnapshotCached(user, time);

  // Only surface timings on the cache-miss path (the hit path skips the
  // whole builder and leaves `timings` empty).
  if (Object.keys(timings).length > 0) {
    annotate({
      meta: { ...timings, snapshot_extras_present: body.extras !== null },
    });
  }

  const response = apiSuccess(body);
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});
