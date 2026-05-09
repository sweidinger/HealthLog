/**
 * v1.4.16 phase B5e — daily feedback aggregator.
 *
 * Runs once a day (04:00 Europe/Berlin via the pg-boss schedule
 * registered in `reminder-worker.ts`). Aggregates the last 30 days
 * of `RecommendationFeedback` rows into per-(severity, metricSourceType,
 * providerType, promptVersion) buckets and writes a summary JSON to
 * `AppSettings.adminAiInsightsFeedbackSummary` (singleton row).
 *
 * The summary feeds the `/admin/ai-quality` preview that surfaces
 * helpful-rate per severity x provider — a v1.4.17 ratchet will read
 * the same shape to drive prompt-tuning (low-helpful-rate buckets
 * get a stricter "OMIT" or "REPHRASE" rule appended next prompt
 * version, per research §5.2).
 *
 * Single-user-default-on policy (research §3): the aggregator runs
 * unconditionally for the user's own ratings. Cross-user training
 * stays admin-only and the summary lives on the singleton AppSettings
 * row that's already gated behind requireAdmin().
 *
 * No prompt mutation in v1.4.16 — the aggregator only writes the
 * summary blob; the prompt-tuning step is deferred to v1.4.17.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export const DEFAULT_FEEDBACK_AGGREGATION_WINDOW_DAYS = 30;

export interface FeedbackBucket {
  severity: string;
  metricSourceType: string;
  providerType: string;
  promptVersion: string;
  helpful: number;
  notHelpful: number;
  total: number;
  /** Fraction in [0..1], rounded to 2 decimals. Always 0 when total=0. */
  helpfulRate: number;
}

export interface FeedbackAggregationSummary {
  generatedAt: string;
  windowDays: number;
  buckets: FeedbackBucket[];
}

interface MinimalFeedbackRow {
  recommendationSeverity: string;
  metricSourceType: string;
  providerType: string;
  promptVersion: string;
  helpful: boolean;
}

/**
 * Pure helper — group rows by the four-tuple key and compute helpful
 * counts per bucket. Exported so the unit test can pin the bucketing
 * shape without going through Prisma. Callers that already have rows
 * in memory (admin-only ad-hoc analysis tools) can reuse this without
 * the Prisma roundtrip.
 *
 * Sort order is deterministic: severity, then metricSourceType, then
 * providerType, then promptVersion. The admin UI rendering this list
 * relies on the order being stable across aggregator runs.
 */
export function buildFeedbackBuckets(
  rows: MinimalFeedbackRow[],
): FeedbackBucket[] {
  const map = new Map<string, FeedbackBucket>();
  for (const row of rows) {
    const key = [
      row.recommendationSeverity,
      row.metricSourceType,
      row.providerType,
      row.promptVersion,
    ].join("");
    const existing = map.get(key);
    if (existing) {
      if (row.helpful) existing.helpful += 1;
      else existing.notHelpful += 1;
      existing.total += 1;
    } else {
      map.set(key, {
        severity: row.recommendationSeverity,
        metricSourceType: row.metricSourceType,
        providerType: row.providerType,
        promptVersion: row.promptVersion,
        helpful: row.helpful ? 1 : 0,
        notHelpful: row.helpful ? 0 : 1,
        total: 1,
        helpfulRate: 0,
      });
    }
  }

  const buckets = [...map.values()];
  for (const b of buckets) {
    b.helpfulRate =
      b.total === 0 ? 0 : Math.round((b.helpful / b.total) * 100) / 100;
  }

  buckets.sort((a, b) => {
    return (
      a.severity.localeCompare(b.severity) ||
      a.metricSourceType.localeCompare(b.metricSourceType) ||
      a.providerType.localeCompare(b.providerType) ||
      a.promptVersion.localeCompare(b.promptVersion)
    );
  });

  return buckets;
}

export interface AggregateOptions {
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
  /** Override the rolling window. Defaults to 30 days. */
  windowDays?: number;
}

/**
 * Read the rolling-window feedback rows, bucket them, and persist the
 * summary to the singleton AppSettings row. Returns the summary so
 * callers (the worker handler, ad-hoc admin tools) can log a digest.
 */
export async function aggregateRecommendationFeedback(
  prisma: PrismaClient,
  options: AggregateOptions = {},
): Promise<FeedbackAggregationSummary> {
  const now = options.now ?? new Date();
  const windowDays =
    options.windowDays ?? DEFAULT_FEEDBACK_AGGREGATION_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const rows = await prisma.recommendationFeedback.findMany({
    where: { createdAt: { gte: since } },
    select: {
      recommendationSeverity: true,
      metricSourceType: true,
      providerType: true,
      promptVersion: true,
      helpful: true,
    },
  });

  const summary: FeedbackAggregationSummary = {
    generatedAt: now.toISOString(),
    windowDays,
    buckets: buildFeedbackBuckets(rows),
  };

  // The singleton AppSettings row is auto-created on first install
  // (`/admin/general` already touches it). Use upsert so the
  // aggregator works on a fresh DB during testcontainer integration
  // runs without depending on init ordering.
  await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: {
      adminAiInsightsFeedbackSummary: summary as unknown as object,
    },
    create: {
      id: "singleton",
      adminAiInsightsFeedbackSummary: summary as unknown as object,
    },
  });

  return summary;
}
