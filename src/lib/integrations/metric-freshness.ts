/**
 * F-SYNC-1 — per-metric-type freshness (the smallest honest signal).
 *
 * Freshness was tracked only per-integration (`IntegrationStatus.lastSuccessAt`
 * / a connection's `lastSyncedAt`). A provider that returns HTTP 200 with an
 * empty body for ONE data type produces zero rows, throws nothing, and the
 * other types in the same cycle stamp the whole integration green — so the
 * Settings pill reads "connected · 5 min ago" while, say, respiratory rate has
 * been dead since launch, and nothing distinguishes "broken pipe" from "healthy
 * but idle".
 *
 * This computes the last-value timestamp per `(source, type)` straight from the
 * `Measurement` table (no schema change, no migration) so a caller can surface
 * per-metric liveness honestly: a metric whose newest reading is frozen weeks in
 * the past is visibly distinct from one that is genuinely current. The coarser
 * "is this stale for THIS metric's expected cadence" classification (per-type
 * thresholds / an expected-cadence probe cron) is the deferred fuller model;
 * this exposes the raw honest timestamp the UI renders as "last seen …".
 */
import { prisma } from "@/lib/db";
import type { MeasurementSource } from "@/generated/prisma/client";
import type { IntegrationKey } from "./status";

/**
 * The `MeasurementSource` each sync integration's rows carry. `moodlog` is
 * absent — it writes `MoodEntry` rows, not `Measurement` rows, so it has no
 * per-metric measurement freshness.
 */
export const INTEGRATION_MEASUREMENT_SOURCE: Partial<
  Record<IntegrationKey, MeasurementSource>
> = {
  withings: "WITHINGS",
  whoop: "WHOOP",
  fitbit: "FITBIT",
  nightscout: "NIGHTSCOUT",
  polar: "POLAR",
  oura: "OURA",
  "google-health": "GOOGLE_HEALTH",
};

/** Newest recorded reading for one `(source, type)` pair. */
export interface MetricFreshnessEntry {
  /** The `MeasurementType` (e.g. "RESPIRATORY_RATE"). */
  type: string;
  /** ISO timestamp of the newest (non-deleted) reading for this metric. */
  lastSeenAt: string;
}

/**
 * Compute per-`(integration, type)` last-value timestamps for the sync
 * integrations, keyed by `IntegrationKey`. One grouped query over the live
 * `Measurement` rows; a source with no rows simply has no entry. Types are
 * sorted alphabetically for a stable wire shape.
 */
export async function getSourceMetricFreshness(
  userId: string,
): Promise<Partial<Record<IntegrationKey, MetricFreshnessEntry[]>>> {
  const sources = Object.values(INTEGRATION_MEASUREMENT_SOURCE);
  const grouped = await prisma.measurement.groupBy({
    by: ["source", "type"],
    where: { userId, deletedAt: null, source: { in: sources } },
    _max: { measuredAt: true },
  });

  // Invert the source→key map once so each grouped row resolves its integration.
  const sourceToKey = new Map<MeasurementSource, IntegrationKey>(
    (
      Object.entries(INTEGRATION_MEASUREMENT_SOURCE) as Array<
        [IntegrationKey, MeasurementSource]
      >
    ).map(([key, source]) => [source, key]),
  );

  const out: Partial<Record<IntegrationKey, MetricFreshnessEntry[]>> = {};
  for (const row of grouped) {
    const lastSeen = row._max.measuredAt;
    if (!lastSeen) continue;
    const key = sourceToKey.get(row.source);
    if (!key) continue;
    (out[key] ??= []).push({
      type: row.type,
      lastSeenAt: lastSeen.toISOString(),
    });
  }

  for (const key of Object.keys(out) as IntegrationKey[]) {
    out[key]!.sort((a, b) => a.type.localeCompare(b.type));
  }
  return out;
}
