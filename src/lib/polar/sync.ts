/**
 * v1.17.0 (F4) — Polar AccessLink sync.
 *
 * Pulls Nightly Recharge (→ RECOVERY_SCORE / HRV / RHR / respiratory rate),
 * sleep (per-stage durations + sleep score), and daily activity (steps +
 * active energy) for one connected user, mapping each into `Measurement` rows
 * tagged `source = POLAR`.
 *
 * Token model: Polar tokens do not expire and have no refresh path, so there is
 * no `getValidToken` refresh dance (the WHOOP shape). A revoked grant surfaces
 * as a 401 → `reauth_required` on the shared integration ledger (`polar` key),
 * exactly like Nightscout's token-rejected path.
 *
 * Idempotency: each row's `externalId` is `<date>:<fieldTag>` and the write is
 * an upsert keyed on `(userId, type, source = POLAR, externalId)`. Polar
 * re-scores a night for a short window after the fact, so the `update` branch
 * overwrites in place (WHOOP-style re-score), not first-write-wins.
 *
 * The measurement-write tail (per-row upsert → rollup fold → status-insight
 * invalidate) mirrors the shared WHOOP / Nightscout sync tail; it is NOT a new
 * write path.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import {
  recordSyncFailure,
  recordSyncSuccess,
  toFailureKind,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import {
  fetchActivities,
  fetchNightlyRecharges,
  fetchSleeps,
  mapActivity,
  mapNightlyRecharge,
  mapSleep,
  type MappedMeasurement,
} from "./client";
import { getPolarConnection } from "./credentials";
import { PolarApiError, classifyPolarError } from "./response-classifier";

/** Map a Polar error onto the shared integration-ledger failure kind. */
export function classifyPolarFailure(err: unknown): FailureKind {
  return toFailureKind(classifyPolarError(err));
}

/** One mapped reading with its `externalId` resolved. */
export interface PolarMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | null;
}

function toUpsert(
  mapped: MappedMeasurement[],
  resourcePrefix: string,
): PolarMeasurementUpsert[] {
  return mapped.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt,
    // `<resource>:<date>:<fieldTag>` — stable across re-syncs of the same day.
    externalId: `${resourcePrefix}:${m.measuredAt.toISOString().slice(0, 10)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/**
 * Sync one user's Polar data. Returns the count of measurement rows written.
 * A user with no Polar connection is a clean no-op (returns 0, touches no
 * status row).
 */
export async function syncUserPolar(userId: string): Promise<number> {
  const conn = await getPolarConnection(userId);
  if (!conn) return 0;

  const readings: PolarMeasurementUpsert[] = [];
  try {
    const [recharges, sleeps, activities] = await Promise.all([
      fetchNightlyRecharges(conn.accessToken, conn.polarUserId),
      fetchSleeps(conn.accessToken, conn.polarUserId),
      fetchActivities(conn.accessToken, conn.polarUserId),
    ]);
    for (const r of recharges) {
      readings.push(...toUpsert(mapNightlyRecharge(r), "recharge"));
    }
    for (const s of sleeps) {
      readings.push(...toUpsert(mapSleep(s), "sleep"));
    }
    for (const a of activities) {
      readings.push(...toUpsert(mapActivity(a), "activity"));
    }
  } catch (err) {
    await recordSyncFailure({
      userId,
      integration: "polar",
      kind: classifyPolarFailure(err),
      message: err instanceof Error ? err.message : String(err),
      errorCode:
        err instanceof PolarApiError && err.httpStatus != null
          ? String(err.httpStatus)
          : undefined,
    });
    throw err;
  }

  const imported = await upsertPolarMeasurements(userId, readings);
  await recordSyncSuccess(userId, "polar");
  return imported;
}

/**
 * Upsert a batch of mapped Polar readings, then fold the rollup tier +
 * invalidate status-insight caches once at the end (mirrors the WHOOP /
 * Nightscout sync tail). Idempotent: the `(userId, type, source, externalId)`
 * unique key makes a re-post overwrite in place. Best-effort on the rollup fold.
 */
export async function upsertPolarMeasurements(
  userId: string,
  readings: PolarMeasurementUpsert[],
): Promise<number> {
  if (readings.length === 0) return 0;

  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  for (const r of readings) {
    const type = r.type as MeasurementType;
    try {
      await prisma.measurement.upsert({
        where: {
          userId_type_source_externalId: {
            userId,
            type,
            source: "POLAR",
            externalId: r.externalId,
          },
        },
        create: {
          userId,
          type,
          source: "POLAR",
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          externalId: r.externalId,
          sleepStage: r.sleepStage ?? null,
        },
        update: {
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          sleepStage: r.sleepStage ?? null,
          syncVersion: { increment: 1 },
        },
      });
      touched.push({ type, measuredAt: r.measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`polar: failed to upsert measurement: ${err}`);
    }
  }

  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `polar: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(`polar: rollup recompute failed for ${userId}: ${err}`);
  }

  return imported;
}
