import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  fetchMoodAggregates,
  type MoodAggregates,
} from "@/lib/insights/mood-aggregates";

export const dynamic = "force-dynamic";

/**
 * v1.8.5 — pre-computed mood-insights aggregates for the Mood Insights
 * page (heatmap, distribution, weekday pattern, tag breakdown,
 * cross-metric correlations, summary headline).
 *
 * The page stays a client component for the interactive line chart but
 * reads the heavy aggregates from here: the compute runs server-side
 * once per 60-s cache window, the browser only ever receives pre-shaped
 * data (no raw mood rows). This follows the v1.8.3 anti-freeze posture
 * — a cheap cached read, never a synchronous LLM call.
 *
 * v1.12.1 — stale-while-revalidate. On an expired or freshly-marked-
 * stale bucket (a mood write marks rather than evicts) the prior
 * aggregate is served immediately and a single background recompute
 * warms a fresh one, so an active logger never re-pays the cold compute.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const result = await cachedSwr(
    caches.moodInsights as ServerCache<MoodAggregates>,
    user.id,
    () => fetchMoodAggregates(user.id),
    annotate,
  );

  annotate({
    action: { name: "mood.insights.read" },
    meta: {
      total_entries: result.summary.totalEntries,
      heatmap_window_days: result.heatmap.windowDays,
      tag_count: result.tags.length,
    },
  });

  return apiSuccess(result);
});
