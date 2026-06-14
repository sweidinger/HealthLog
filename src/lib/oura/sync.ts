/**
 * v1.17.0 (F4) — Oura Cloud v2 sync.
 *
 * Pulls daily readiness (→ RECOVERY_SCORE), sleep (per-stage durations,
 * efficiency, HRV, RHR, respiratory rate), and daily activity (steps + active
 * energy) for one connected user, mapping each into `Measurement` rows tagged
 * `source = OURA`.
 *
 * Token model: Oura uses refresh tokens. The merged schema has no expiry
 * column, so the sync refreshes REACTIVELY — the first read that 401s triggers
 * one refresh (persisting BOTH rotated tokens) and a single retry. A failed
 * refresh (`invalid_grant`) records `reauth_required` on the `oura` ledger.
 *
 * Idempotency: `externalId = <resource>:<day>:<fieldTag>`, upsert keyed on
 * `(userId, type, source = OURA, externalId)`. Oura finalises a day's scores
 * after the night, so the `update` branch overwrites in place (re-score).
 *
 * The measurement-write tail mirrors the shared WHOOP / Nightscout sync tail.
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
  fetchDailyActivity,
  fetchReadiness,
  fetchSleep,
  getOuraCredentials,
  mapDailyActivity,
  mapReadiness,
  mapSleep,
  refreshAccessToken,
  type MappedMeasurement,
} from "./client";
import { getOuraConnection, storeOuraTokens } from "./credentials";
import { OuraApiError, classifyOuraError } from "./response-classifier";

/** Default lookback window (days) for an incremental sync. Oura finalises a
 * night's scores hours after wake; 7 days re-fetches a handful of records (the
 * upserts are idempotent) and closes any catch-up gap. */
export const OURA_SYNC_LOOKBACK_DAYS = 7;

export function classifyOuraFailure(err: unknown): FailureKind {
  return toFailureKind(classifyOuraError(err));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface OuraMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | null;
}

function toUpsert(
  mapped: MappedMeasurement[],
  resourcePrefix: string,
): OuraMeasurementUpsert[] {
  return mapped.map((m) => ({
    type: m.type,
    value: m.value,
    unit: m.unit,
    measuredAt: m.measuredAt,
    externalId: `${resourcePrefix}:${ymd(m.measuredAt)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/**
 * Fetch all three Oura collections for a user with a single reactive
 * refresh-on-401 retry. Returns the raw mapped readings (not yet upserted).
 * Throws a classified `OuraApiError` on a hard failure so the caller records
 * the ledger entry.
 */
async function fetchAll(
  userId: string,
  accessToken: string,
  refreshToken: string,
  lookbackDays: number,
): Promise<OuraMeasurementUpsert[]> {
  const now = new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const query = { startDate: ymd(start), endDate: ymd(now) };

  const run = async (token: string): Promise<OuraMeasurementUpsert[]> => {
    const [readiness, sleeps, activities] = await Promise.all([
      fetchReadiness(token, query),
      fetchSleep(token, query),
      fetchDailyActivity(token, query),
    ]);
    const out: OuraMeasurementUpsert[] = [];
    for (const r of readiness) out.push(...toUpsert(mapReadiness(r), "readiness"));
    for (const s of sleeps) out.push(...toUpsert(mapSleep(s), "sleep"));
    for (const a of activities) out.push(...toUpsert(mapDailyActivity(a), "activity"));
    return out;
  };

  try {
    return await run(accessToken);
  } catch (err) {
    // Reactive refresh: a 401 means the access token expired. Refresh once
    // (rotating both tokens) and retry. A 403 / other error is NOT a refresh
    // case — rethrow so the caller classifies it.
    if (!(err instanceof OuraApiError) || err.httpStatus !== 401) throw err;

    const creds = getOuraCredentials();
    if (!creds) throw err;

    const rotated = await refreshAccessToken(refreshToken, creds);
    await storeOuraTokens(userId, rotated.access_token, rotated.refresh_token);
    return run(rotated.access_token);
  }
}

/**
 * Sync one user's Oura data. Returns the count of measurement rows written.
 * A user with no Oura connection is a clean no-op (returns 0, touches no
 * status row).
 */
export async function syncUserOura(
  userId: string,
  opts: { lookbackDays?: number } = {},
): Promise<number> {
  const conn = await getOuraConnection(userId);
  if (!conn) return 0;

  let readings: OuraMeasurementUpsert[];
  try {
    readings = await fetchAll(
      userId,
      conn.accessToken,
      conn.refreshToken,
      opts.lookbackDays ?? OURA_SYNC_LOOKBACK_DAYS,
    );
  } catch (err) {
    await recordSyncFailure({
      userId,
      integration: "oura",
      kind: classifyOuraFailure(err),
      message: err instanceof Error ? err.message : String(err),
      errorCode:
        err instanceof OuraApiError && err.httpStatus != null
          ? String(err.httpStatus)
          : undefined,
    });
    throw err;
  }

  const imported = await upsertOuraMeasurements(userId, readings);
  await recordSyncSuccess(userId, "oura");
  return imported;
}

export async function upsertOuraMeasurements(
  userId: string,
  readings: OuraMeasurementUpsert[],
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
            source: "OURA",
            externalId: r.externalId,
          },
        },
        create: {
          userId,
          type,
          source: "OURA",
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
      getEvent()?.addWarning(`oura: failed to upsert measurement: ${err}`);
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
        `oura: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(`oura: rollup recompute failed for ${userId}: ${err}`);
  }

  return imported;
}
