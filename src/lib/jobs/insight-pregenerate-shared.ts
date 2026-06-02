/**
 * v1.8.7.1 — generator-free contract for the insight-pregenerate queue.
 *
 * The on-demand warm route (`POST /api/insights/pregenerate`) enqueues a
 * forced full-warm job here without importing the concrete generators
 * (which would pull the whole `comprehensive-generate` + seven `*-status`
 * tree into the route bundle and risk an import cycle). The worker-only
 * pipeline (`runInsightPregenerate`, `forceWarmUser`) lives in
 * `insight-pregenerate.ts`, which re-exports the queue name from here so
 * there is a single source of truth.
 *
 * Mirrors the `insight-status-generate-shared.ts` split exactly: queue
 * name + payload type + enqueue helper in the generator-free module, the
 * concrete dispatch in the worker module.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const INSIGHT_PREGENERATE_QUEUE = "insight-pregenerate";

export interface InsightPregeneratePayload {
  /** Set on the nightly scheduled tick (informational; the handler keys
   * its batch behaviour off the ABSENCE of `userId`/`force`). */
  triggeredAt?: string;
  /**
   * Forced single-user warm. When `force` is set the worker runs the
   * full per-user warm for `userId` directly, bypassing the candidate
   * scan AND the per-user 20 h budget bucket.
   */
  userId?: string;
  force?: boolean;
  /** Locale to warm on the forced path; defaults to "de" when absent. */
  locale?: "de" | "en";
}

/**
 * Fire-and-forget enqueue used by the on-demand warm route. A
 * `singletonKey` per `(user, locale)` collapses repeated requests within
 * a short window into one queued job, so a client that taps the button
 * twice (or the auto-trigger races a manual tap) can't double-warm. No-ops
 * cleanly when the global boss instance is not available (e.g. a web
 * process without an embedded worker) — the nightly cron remains the
 * catch-net.
 */
export async function enqueueForceWarm(payload: {
  userId: string;
  locale: "de" | "en";
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "insights.pregenerate.force.no_boss" },
      meta: { locale: payload.locale },
    });
    return;
  }
  try {
    await boss.send(
      INSIGHT_PREGENERATE_QUEUE,
      {
        userId: payload.userId,
        force: true,
        locale: payload.locale,
      } satisfies InsightPregeneratePayload,
      {
        singletonKey: `force:${payload.userId}:${payload.locale}`,
        // De-dupe within a 2-minute window so a double tap or an
        // auto-trigger racing a manual tap enqueues one warm, not two.
        singletonSeconds: 120,
      },
    );
    annotate({
      action: { name: "insights.pregenerate.force.enqueued" },
      meta: { locale: payload.locale },
    });
  } catch {
    // Enqueue is best-effort; a failure here just means the caches stay
    // cold until the next poll / nightly cron warms them.
  }
}
