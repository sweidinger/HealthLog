/**
 * v1.8.3 — shared contract for the on-demand per-metric status generation
 * queue, free of any generator import.
 *
 * The status generators import `enqueueStatusGeneration` from here (via
 * `status-cache.ts`). Keeping the enqueue + the queue name + the metric
 * vocabulary in a generator-free module breaks the import cycle that would
 * otherwise form: generator → status-cache → (enqueue) → generator. The
 * worker-only dispatch (`runInsightStatusGenerate`, which references the
 * concrete generators) lives in `insight-status-generate.ts` and is
 * imported solely by the worker boot file.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const INSIGHT_STATUS_GENERATE_QUEUE = "insight-status-generate";

/**
 * Low concurrency keeps the on-demand warm pass from saturating the
 * Prisma pool or fanning out an unbounded number of concurrent provider
 * calls when several cards request generation on the same first visit.
 */
export const INSIGHT_STATUS_GENERATE_CONCURRENCY = 2;

/**
 * The seven per-metric status scopes the queue can generate. Mirrors the
 * `cacheAction` slug each generator uses (`insights.<metric>-status.<locale>`)
 * so the queue payload, the route, and the client all speak one vocabulary.
 */
export type InsightStatusMetric =
  | "general"
  | "blood-pressure"
  | "weight"
  | "pulse"
  | "bmi"
  | "mood"
  | "medication-compliance";

export const INSIGHT_STATUS_METRICS: ReadonlyArray<InsightStatusMetric> = [
  "general",
  "blood-pressure",
  "weight",
  "pulse",
  "bmi",
  "mood",
  "medication-compliance",
];

/**
 * v1.8.7.1 — the generic per-HealthKit-metric assessment scopes ride the
 * same on-demand queue. Their scope id is `metric:<METRIC_ID>` (see
 * `metricStatusScope` in the registry), which the worker dispatch routes
 * to the generic generator rather than one of the seven specialised
 * ones. The queue payload, the read-only resolver, and the enqueue helper
 * all accept this broader scope so a generic card warms exactly like a
 * specialised one. A specialised scope is one of `InsightStatusMetric`;
 * a generic scope is any `metric:`-prefixed string.
 */
export type InsightStatusScope =
  | InsightStatusMetric
  | `metric:${string}`
  /**
   * v1.13.2 — per-derived-SCORE assessment scopes (READINESS, SLEEP_SCORE,
   * RECOVERY_SCORE, STRAIN_SCORE, STRESS_SCORE) ride the same on-demand queue.
   * Their scope id is `derived-score:<DERIVED_METRIC_ID>`; the worker routes
   * the prefix to the per-score assessment generator. The deterministic text
   * always fills the field synchronously — this queue only warms the AI prose
   * that overrides it on the next read.
   */
  | `derived-score:${string}`
  /**
   * Per-biomarker assessment scopes ride the same on-demand queue. Their
   * scope id is `biomarker:<id>`; the worker routes the prefix to the
   * biomarker generator, which reads `LabResult` rows for the marker and
   * applies its own empty-data + input-hash gates, so a job enqueued for a
   * marker with no new reading costs only a cheap fingerprint, not an LLM
   * call.
   */
  | `biomarker:${string}`;

export interface InsightStatusGeneratePayload {
  userId: string;
  /**
   * The scope to generate. A specialised scope (one of the seven) or a
   * generic `metric:<METRIC_ID>` scope (v1.8.7.1). The worker dispatch
   * routes the prefix to the right generator.
   */
  metric: InsightStatusScope;
  /** Resolved client locale — the cache key the route reads against. */
  locale: "de" | "en";
}

/**
 * Fire-and-forget enqueue used by the read-only status route on a cache
 * miss. A `singletonKey` per `(user, metric, locale)` collapses repeated
 * polls into one queued job, so a client polling every few seconds while
 * the provider works can't pile up duplicate generations. No-ops cleanly
 * when the global boss instance is not available (e.g. the web process
 * runs without an embedded worker) — the nightly pre-generate cron and
 * the daily status crons remain the catch-net.
 */
export async function enqueueStatusGeneration(
  payload: InsightStatusGeneratePayload,
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "insights.status.generate.no_boss" },
      meta: { metric: payload.metric },
    });
    return;
  }
  try {
    await boss.send(INSIGHT_STATUS_GENERATE_QUEUE, payload, {
      singletonKey: `${payload.userId}:${payload.metric}:${payload.locale}`,
      // De-dupe within a short window so a polling client doesn't enqueue
      // a fresh job on every tick while a generation is already running.
      singletonSeconds: 120,
      // Transient provider / pool failures retry with backoff instead of
      // leaving the card on "preparing" until the next nightly cron.
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
    annotate({
      action: { name: "insights.status.generate.enqueued" },
      meta: { metric: payload.metric },
    });
  } catch {
    // Enqueue is best-effort; a failure here just means the card stays
    // in `preparing` until the next poll / nightly cron warms the cache.
  }
}
