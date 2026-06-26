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
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import {
  buildDashboardSnapshot,
  type DashboardSnapshot,
  type SnapshotUserInput,
} from "@/lib/dashboard/snapshot";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

/**
 * Per-key TTL for the snapshot cache entry. Strictly greater than the
 * client's 120 s refetch interval so a scheduled poll lands on a warm
 * entry instead of a guaranteed miss that re-runs the full builder. The
 * 60 s headroom absorbs interval jitter / a poll firing a touch late.
 * The analytics bucket's 60 s default still governs the slim / thick /
 * mood cells; only this key is lengthened. Eviction on writes is
 * unchanged (the `${userId}|` prefix sweep / point-delete both ignore
 * the TTL).
 */
const SNAPSHOT_CACHE_TTL_MS = DASHBOARD_REFETCH_INTERVAL_MS + 60_000;

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

  // `requireAuth().user` is the full Prisma `User` row, so every field
  // the builder needs is already present — no extra round-trip.
  const snapshotUser: SnapshotUserInput = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    timezone: user.timezone,
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    glucoseUnit: user.glucoseUnit,
    onboardingTourCompleted: user.onboardingTourCompleted,
    disableCoach: user.disableCoach,
    insightsCachedText: user.insightsCachedText,
    insightsCachedAt: user.insightsCachedAt,
    dashboardWidgetsJson: user.dashboardWidgetsJson,
  };

  // v1.21.2 (A4) — the briefing recall + forward-look is locale-specific prose,
  // so the snapshot cache key carries the resolved locale: an EN and a DE
  // session never share a snapshot cell (and never see each other's memory
  // wording). The `${user.id}|` prefix still covers the key under the
  // measurement-write stale-sweep.
  const locale = await resolveServerLocale({ userLocale: user.locale });

  // Stale-while-revalidate: a measurement write marks the analytics
  // bucket stale rather than hard-evicting the snapshot, so a busy iOS
  // sync serves the prior snapshot immediately (within the bucket's
  // stale window) while a single background recompute warms a fresh one
  // — the foreground request never pays the cold rebuild. Hard-evicting
  // writes (widget reorder) still drop the key outright, forcing a clean
  // miss + synchronous rebuild here.
  const body = await cachedSwr(
    caches.analytics as ServerCache<DashboardSnapshot>,
    `${user.id}|dashboard-snapshot|${locale}`,
    () => buildDashboardSnapshot(prisma, snapshotUser, { time, locale }),
    annotate,
    SNAPSHOT_CACHE_TTL_MS,
  );

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
