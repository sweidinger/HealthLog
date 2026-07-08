/**
 * v1.17.0 (F4) — Oura Cloud v2 sync.
 *
 * Pulls daily readiness (→ RECOVERY_SCORE + BODY_TEMPERATURE_DEVIATION), sleep
 * (real per-segment hypnogram timeline when present, else per-stage totals;
 * efficiency, HRV, RHR, respiratory rate), daily activity (steps, active
 * energy, equivalent walking distance), the daily Sleep Score (→ SLEEP_SCORE),
 * daily SpO2 (→ OXYGEN_SATURATION), the dedicated vO2_max collection (→
 * VO2_MAX), and the daily cardiovascular-age estimate (→ VASCULAR_AGE) for one
 * connected user, mapping each into `Measurement` rows tagged `source = OURA`.
 *
 * daily_stress → STRESS_SCORE is deferred: STRESS_SCORE already has an
 * HRV-derived COMPUTED producer that is not yet wired into the source-priority
 * ladder or the weekly graded-series collapse, so a second producer here would
 * double-count nondeterministically. Re-add once STRESS_SCORE is laddered.
 *
 * daily_resilience → RESILIENCE (v1.19.0): the daily resilience LEVEL (limited /
 * adequate / solid / strong / exceptional) is ordinal-encoded (limited=1 …
 * exceptional=5) into the numeric `value` — no new categorical column. An
 * unknown / missing level mints no row. See `RESILIENCE_LEVELS` in `./client`.
 *
 * Token model: Oura uses refresh tokens. The merged schema has no expiry
 * column, so the sync refreshes REACTIVELY — the first read that 401s triggers
 * one refresh (persisting BOTH rotated tokens) and a single retry. A failed
 * refresh (`invalid_grant`) records `reauth_required` on the `oura` ledger.
 *
 * Idempotency: `externalId = <resource>:<day>:<fieldTag>` for the day-keyed
 * collections; sleep rows carry a record-scoped `sleep:<record-id>:<fieldTag>`
 * key (per-segment timeline + nightly scalars) so a nap and the main sleep on
 * one day stay distinct instead of overwriting each other (B2). Upsert keyed on
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
  fetchCardiovascularAge,
  fetchDailyActivity,
  fetchDailySleep,
  fetchDailySpo2,
  fetchReadiness,
  fetchResilience,
  fetchSleep,
  fetchVo2Max,
  mapCardiovascularAge,
  mapDailyActivity,
  mapDailySleep,
  mapDailySpo2,
  mapReadiness,
  mapResilience,
  mapSleep,
  mapVo2Max,
  refreshAccessToken,
  type MappedMeasurement,
} from "./client";
import {
  getOuraClientCredentials,
  getOuraConnection,
  storeOuraTokens,
} from "./credentials";
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
    // A mapper that needs a record-scoped key (sleep rows — per-segment timeline
    // + nightly scalars) carries its own externalId; everything else falls back
    // to the day-keyed `<resource>:<day>:<fieldTag>` shape.
    externalId:
      m.externalId ?? `${resourcePrefix}:${ymd(m.measuredAt)}:${m.fieldTag}`,
    sleepStage: m.sleepStage ?? null,
  }));
}

/** One Oura collection: its ledger name and a self-contained fetch+map closure
 * that resolves to the collection's mapped upserts. Each closure owns its own
 * client call and mapper so a throw is contained to this one collection. */
interface OuraCollectionSpec {
  name: string;
  collect: (token: string) => Promise<OuraMeasurementUpsert[]>;
}

/** A single collection that failed to fetch/map, carried so the caller can
 * classify + record the failure without blanking the collections that did
 * succeed. */
export interface OuraCollectionFailure {
  name: string;
  err: unknown;
}

export interface OuraFetchResult {
  readings: OuraMeasurementUpsert[];
  failures: OuraCollectionFailure[];
}

/**
 * Fetch every Oura daily collection for a user with a single reactive
 * refresh-on-401 retry, ISOLATED per collection. Unlike a bare `Promise.all`,
 * one flaky endpoint or one throwing mapper no longer rejects the whole batch
 * (which used to blank readiness, sleep, activity, spo2 all at once). Each
 * collection is settled independently (`Promise.allSettled`); the ones that
 * succeed import, the ones that throw are returned as `failures` for the caller
 * to record — mirroring Google Health's / Fitbit's per-collection hard-fail
 * ledger.
 *
 * The reactive refresh is preserved: because every collection shares one access
 * token, an expired token 401s all of them together; a single refresh is done
 * once and ONLY the failed collections are retried with the rotated token. A
 * failed refresh (`invalid_grant`) still throws so the caller parks the whole
 * connection at `reauth_required`.
 */
async function fetchAll(
  userId: string,
  accessToken: string,
  refreshToken: string,
  refreshTokenCiphertext: string,
  lookbackDays: number,
): Promise<OuraFetchResult> {
  const now = new Date();
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const query = { startDate: ymd(start), endDate: ymd(now) };

  const collections: OuraCollectionSpec[] = [
    {
      name: "readiness",
      collect: async (t) =>
        (await fetchReadiness(t, query)).flatMap((r) =>
          toUpsert(mapReadiness(r), "readiness"),
        ),
    },
    {
      name: "sleep",
      collect: async (t) =>
        (await fetchSleep(t, query)).flatMap((s) =>
          toUpsert(mapSleep(s), "sleep"),
        ),
    },
    {
      name: "activity",
      collect: async (t) =>
        (await fetchDailyActivity(t, query)).flatMap((a) =>
          toUpsert(mapDailyActivity(a), "activity"),
        ),
    },
    {
      name: "daily_sleep",
      collect: async (t) =>
        (await fetchDailySleep(t, query)).flatMap((d) =>
          toUpsert(mapDailySleep(d), "daily_sleep"),
        ),
    },
    {
      name: "spo2",
      collect: async (t) =>
        (await fetchDailySpo2(t, query)).flatMap((s) =>
          toUpsert(mapDailySpo2(s), "spo2"),
        ),
    },
    {
      name: "vo2max",
      collect: async (t) =>
        (await fetchVo2Max(t, query)).flatMap((v) =>
          toUpsert(mapVo2Max(v), "vo2max"),
        ),
    },
    {
      name: "cardio_age",
      collect: async (t) =>
        (await fetchCardiovascularAge(t, query)).flatMap((c) =>
          toUpsert(mapCardiovascularAge(c), "cardio_age"),
        ),
    },
    {
      name: "resilience",
      collect: async (t) =>
        (await fetchResilience(t, query)).flatMap((r) =>
          toUpsert(mapResilience(r), "resilience"),
        ),
    },
  ];

  // Run a set of collections isolated from one another. A rejection is captured
  // per-collection, never propagated, so siblings still resolve.
  const attempt = async (
    token: string,
    specs: OuraCollectionSpec[],
  ): Promise<{
    readings: OuraMeasurementUpsert[];
    failed: OuraCollectionSpec[];
    failures: OuraCollectionFailure[];
    auth401: boolean;
  }> => {
    const settled = await Promise.allSettled(
      specs.map((spec) => spec.collect(token)),
    );
    const readings: OuraMeasurementUpsert[] = [];
    const failed: OuraCollectionSpec[] = [];
    const failures: OuraCollectionFailure[] = [];
    let auth401 = false;
    settled.forEach((res, i) => {
      const spec = specs[i]!;
      if (res.status === "fulfilled") {
        readings.push(...res.value);
      } else {
        const err = res.reason;
        if (err instanceof OuraApiError && err.httpStatus === 401)
          auth401 = true;
        failed.push(spec);
        failures.push({ name: spec.name, err });
      }
    });
    return { readings, failed, failures, auth401 };
  };

  const first = await attempt(accessToken, collections);
  if (!first.auth401) {
    return { readings: first.readings, failures: first.failures };
  }

  // Reactive refresh: the access token expired (a 401 on the shared token).
  // Refresh once (rotating both tokens) and retry ONLY the collections that
  // failed. A failed refresh throws so the caller parks reauth_required.
  const creds = await getOuraClientCredentials(userId);
  if (!creds) return { readings: first.readings, failures: first.failures };

  const rotated = await refreshAccessToken(refreshToken, creds);
  // Compare-and-swap persist: on a lost race against a concurrent sync this
  // returns the peer's freshly rotated access token rather than the (now
  // invalidated) one we just minted, so neither sync parks the connection.
  const usableToken = await storeOuraTokens(
    userId,
    rotated.access_token,
    rotated.refresh_token,
    refreshTokenCiphertext,
  );
  if (!usableToken) return { readings: first.readings, failures: first.failures };

  const retry = await attempt(usableToken, first.failed);
  return {
    readings: [...first.readings, ...retry.readings],
    failures: retry.failures,
  };
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

  let result: OuraFetchResult;
  try {
    result = await fetchAll(
      userId,
      conn.accessToken,
      conn.refreshToken,
      conn.refreshTokenCiphertext,
      opts.lookbackDays ?? OURA_SYNC_LOOKBACK_DAYS,
    );
  } catch (err) {
    // Only a whole-connection failure (a failed token refresh → reauth) reaches
    // here now; per-collection failures are captured on `result.failures`.
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

  // Import everything the healthy collections returned regardless of whether a
  // sibling collection failed — one bad collection must not blank the source.
  const imported = await upsertOuraMeasurements(userId, result.readings);

  if (result.failures.length > 0) {
    // Partial failure: keep the cycle honest. Record the failure and do NOT
    // stamp success, so the freshness surface reflects that some collections
    // are behind and the next tick refetches them, rather than showing green.
    const firstErr = result.failures[0]!.err;
    getEvent()?.addWarning(
      `oura: ${result.failures.length} collection(s) failed for ${userId}: ${result.failures
        .map((f) => f.name)
        .join(", ")}`,
    );
    await recordSyncFailure({
      userId,
      integration: "oura",
      kind: classifyOuraFailure(firstErr),
      message: `partial sync failure (${result.failures
        .map((f) => f.name)
        .join(", ")}): ${
        firstErr instanceof Error ? firstErr.message : String(firstErr)
      }`,
      errorCode:
        firstErr instanceof OuraApiError && firstErr.httpStatus != null
          ? String(firstErr.httpStatus)
          : undefined,
    });
    return imported;
  }

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
    getEvent()?.addWarning(
      `oura: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return imported;
}
