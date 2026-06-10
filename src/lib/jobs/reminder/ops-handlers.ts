/**
 * Operational handlers: host metric sampling, recommendation-feedback aggregation, geo backfill, TLS pin monitoring, and personal-record detection.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { runGeoBackfill } from "@/lib/jobs/geo-backfill";
import { runTlsPinMonitor } from "@/lib/jobs/tls-pin-monitor";
import { type PrDetectionPayload } from "@/lib/jobs/pr-detection";
import { withBackgroundEvent } from "@/lib/logging/background";
import { runHostMetricTick } from "@/lib/jobs/host-metric-sampler";
import { aggregateRecommendationFeedback } from "@/lib/jobs/feedback-aggregator";
import { detectPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import { getWorkerPrisma } from "./shared";

export interface HostMetricSamplePayload {
  triggeredAt: string;
}

export interface FeedbackAggregatorPayload {
  triggeredAt: string;
}

export interface GeoBackfillPayload {
  triggeredAt: string;
}

export interface TlsPinMonitorPayload {
  triggeredAt: string;
}

// Re-export timezone utilities under local names for backward compatibility

export async function handleHostMetricSample(
  jobs: Job<HostMetricSamplePayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.host_metric_sample", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const { pruned } = await runHostMetricTick(p);
      evt.addMeta("host_metric_pruned", pruned);
    } catch (err) {
      // The chart degrades gracefully when samples are missing — log
      // and move on rather than poisoning the boss queue with retries.
      evt.addWarning(`host-metric-sample failed: ${err}`);
    }
  });
}

export async function handleFeedbackAggregator(
  jobs: Job<FeedbackAggregatorPayload>[],
) {
  void jobs;
  await withBackgroundEvent("job.feedback_aggregator", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const summary = await aggregateRecommendationFeedback(p);
      evt.addMeta("feedback_buckets", summary.buckets.length);
      evt.addMeta(
        "feedback_total_rows",
        summary.buckets.reduce((acc, b) => acc + b.total, 0),
      );
      evt.addMeta("feedback_window_days", summary.windowDays);
    } catch (err) {
      // The admin dashboard tolerates a stale summary — log and move
      // on rather than poisoning the boss queue with retries that
      // would block the next cleanup window.
      evt.addWarning(`feedback-aggregator failed: ${err}`);
    }
  });
}

/**
 * v1.4.37 — geo-backfill worker. Walks `audit_logs` rows that landed
 * with a null `location` (offline MMDB missing at write time, online
 * provider unreachable) and re-resolves them through the now-bundled
 * resolver chain. The helper is idempotent and capped per pass so
 * the hourly cadence cannot starve a live login spike.
 *
 * v1.4.38 — in-process singleton guard. pg-boss already coalesces
 * concurrent cron ticks across multiple worker containers via the
 * shared queue lease, but a single container that takes longer than
 * one cron interval can pick up two jobs back-to-back when the
 * second tick fires while the first pass is still running. The
 * in-process `geoBackfillRunning` flag fans the second invocation
 * out as a no-op log line instead of stacking two concurrent passes
 * inside the same Node process — the next cron tick after the first
 * completes will catch up the work the skipped pass would have done.
 */
let geoBackfillRunning = false;

export async function handleGeoBackfill(jobs: Job<GeoBackfillPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.geo_backfill", async (evt) => {
    if (geoBackfillRunning) {
      // Earlier pass still in flight; skip this tick. Idempotent + the
      // next tick after the in-flight pass completes will pick up
      // anything we miss here.
      evt.addWarning(
        "geo-backfill skipped — earlier pass still in flight inside the same worker process",
      );
      evt.addMeta("geo_backfill_skipped", true);
      return;
    }
    geoBackfillRunning = true;
    const p = getWorkerPrisma();
    try {
      const summary = await runGeoBackfill(p);
      evt.addMeta("geo_backfill_scanned", summary.scanned);
      evt.addMeta("geo_backfill_located", summary.located);
      evt.addMeta("geo_backfill_carrier_resolved", summary.carrierResolved);
      evt.addMeta("geo_backfill_still_unresolved", summary.stillUnresolved);
    } catch (err) {
      // The admin sign-in overview tolerates a stale Standort cell —
      // log and move on so a one-off resolver hiccup does not poison
      // the queue and block the next pass.
      evt.addWarning(`geo-backfill failed: ${err}`);
    } finally {
      geoBackfillRunning = false;
    }
  });
}

export async function handleTlsPinMonitor(jobs: Job<TlsPinMonitorPayload>[]) {
  void jobs;
  await withBackgroundEvent("job.tls_pin_monitor", async (evt) => {
    const p = getWorkerPrisma();
    try {
      const summary = await runTlsPinMonitor(p);
      evt.addMeta("tls_pin_monitor_outcome", summary.outcome);
      evt.addMeta("tls_pin_monitor_host", summary.host);
      evt.addMeta("tls_pin_monitor_known_count", summary.knownPinCount);
    } catch (err) {
      // runTlsPinMonitor swallows probe failures internally; anything that
      // escapes is unexpected. Log and move on so a one-off failure does not
      // poison the queue and block the next tick.
      evt.addWarning(`tls-pin-monitor failed: ${err}`);
    }
  });
}

export async function handlePrDetection(
  jobs: Job<PrDetectionPayload | { userId?: undefined }>[],
) {
  for (const job of jobs) {
    await withBackgroundEvent("job.pr_detection", async (evt) => {
      const p = getWorkerPrisma();
      // The cron-fired job carries an empty payload — iterate all
      // users in that case. The push-suppression flag is irrelevant
      // for the cron path (the dispatcher's per-user opt-in handles
      // the loud/quiet decision once the row is written).
      const payloadUserId = (job.data as PrDetectionPayload | undefined)
        ?.userId;
      const silent =
        (job.data as PrDetectionPayload | undefined)?.silent ?? false;
      const userIds: string[] = payloadUserId
        ? [payloadUserId]
        : (await p.user.findMany({ select: { id: true } })).map((u) => u.id);

      let insertedTotal = 0;
      let tiesTotal = 0;
      for (const userId of userIds) {
        try {
          const result = await detectPersonalRecordsForUser(userId, {
            silent,
            prisma: p,
          });
          insertedTotal += result.inserted;
          tiesTotal += result.ties;
        } catch (err) {
          evt.addWarning(`pr-detection failed for user ${userId}: ${err}`);
        }
      }
      evt.addMeta("pr_detection_users", userIds.length);
      evt.addMeta("pr_detection_inserted", insertedTotal);
      evt.addMeta("pr_detection_ties", tiesTotal);
      evt.addMeta("pr_detection_silent", silent);
      evt.addMeta("pr_detection_mode", payloadUserId ? "ingest" : "cron");
    });
  }
}
