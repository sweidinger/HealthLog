import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  buildMoodDailySeries,
  type MoodDailySeries,
} from "@/lib/analytics/mood-series";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  // v1.17.1 — single mood engine: the route and the dashboard snapshot
  // both read through `buildMoodDailySeries`, so the dashboard tile, the
  // insights mood sparkline, and the iOS client all see the same number.
  const result = await cached(
    caches.moodAnalytics as ServerCache<MoodDailySeries>,
    user.id,
    () => buildMoodDailySeries(user.id),
    annotate,
  );

  annotate({
    action: { name: "mood.analytics" },
    meta: {
      entryCount: result.entryCount,
      mood_analytics_path: result.source,
    },
  });

  return apiSuccess({ entries: result.entries, summary: result.summary });
});
