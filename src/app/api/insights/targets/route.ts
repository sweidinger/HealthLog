/**
 * `GET /api/insights/targets` — per-metric target tiles + consistency strips.
 *
 * Thin handler: auth → `cachedSwr(buildTargetsResponse)` → `apiSuccess`. The
 * domain function lives in `@/lib/targets/build-response` so the ~1.4k-line
 * walk can be unit-tested without the route shell.
 */
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { buildTargetsResponse } from "@/lib/targets/build-response";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  // v1.16.8 — stale-while-revalidate read. The cold build is the multi-query
  // walk in `buildTargetsResponse`; past the 60 s fresh TTL the prior body
  // serves immediately while ONE background rebuild warms the cell. Writes
  // hard-evict the bucket (`invalidateUser*` → `deleteByPrefix`), so user
  // actions always reflect on the next read.
  const body = await cachedSwr(
    caches.insightsTargets as ServerCache<
      Awaited<ReturnType<typeof buildTargetsResponse>>
    >,
    user.id,
    () => buildTargetsResponse(user),
    annotate,
  );
  const response = apiSuccess(body);
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});
