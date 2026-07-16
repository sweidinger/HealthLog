/**
 * GET /api/daily/digest
 *
 * The read seam for the unified daily-value system (P3). Returns the
 * `DailyDigest` DTO the Today surface, the daily push, and a future iOS widget
 * all consume — assembled by `loadDailyDigest` from ALREADY-CACHED data (the
 * nightly briefing lifted read-only from `User.insightsCachedText`, the
 * dashboard-snapshot health score / meds-today / sleep freshness) plus two
 * light deterministic reads (broken integrations, overdue Vorsorge). No
 * provider call is reachable from this path, and nothing warms on mount.
 *
 * Cookie OR Bearer auth via `requireAuth()`; `userId` is narrowed from the
 * resolved session — never a body field. Gated on the `insights` module (the
 * daily digest is the AI-narrative daily layer); a disabled account gets the
 * standard 403 `module.disabled` envelope even over a Bearer token. The rail's
 * data-tile inputs inherit their own module gates via the snapshot builder.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { NO_STORE_BUT_BFCACHE } from "@/lib/http/cache-headers";
import { loadDailyDigest } from "@/lib/daily/load-digest";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  const digest = await loadDailyDigest(user);

  const response = apiSuccess(digest);
  response.headers.set("Cache-Control", NO_STORE_BUT_BFCACHE);
  return response;
});
