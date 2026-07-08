/**
 * Fitbit Web API sync service.
 *
 *   - `getValidToken` decrypts the stored token, refreshes at
 *     `tokenExpiresAt - 5 min`, and persists the new access token + expiry AND
 *     the rotated refresh token. Classic Fitbit ROTATES refresh tokens
 *     (one-time use), so the new `refresh_token` MUST replace the stored one —
 *     the inverse of the prior Google transport, which did not rotate. The
 *     persist is a compare-and-swap on the stored ciphertext so two overlapping
 *     syncs cannot park the connection at reauth (see `persistRotatedToken`).
 *   - `recordFitbitSyncFailure` / `classificationToFailureKind` map a
 *     classified API error onto the shared integration-status ledger.
 *   - `upsertFitbitMeasurements` + `syncUserFitbit` own the write tail (dedup,
 *     overwrite contract, rollup fold) — reused unchanged across the transport
 *     fork; only the per-resource fetch/map differs.
 *   - `chunkDateRanges` slices a deep backfill into the per-endpoint date-range
 *     windows the classic Web API caps each call at (30 days), so the per-resource
 *     syncs issue one valid request per window.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pLimit from "p-limit";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { encrypt, decrypt } from "@/lib/crypto";
import { annotate, getEvent } from "@/lib/logging/context";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { persistRotatedToken } from "@/lib/integrations/oauth-refresh";
import { refreshAccessToken } from "./client";
import { getUserFitbitCredentials } from "./credentials";
import {
  FitbitApiError,
  classifyFitbitError,
  type FitbitClassification,
} from "./response-classifier";

/** Refresh the access token this many ms before `tokenExpiresAt`. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Delimiter joining `(type, externalId)` into a single dedup map key. A
 * control character keeps it unambiguous against any value a real type or
 * externalId could contain, while staying a normal printable-safe constant
 * (a literal NUL in the source made text tooling treat the file as binary).
 */
const DEDUP_KEY_DELIM = "\u0000";

/**
 * Overlap window for the incremental sync, in ms. Fitbit finalises daily
 * summaries after the fact (a daily SpO2 / HRV / RHR can settle hours after the
 * night), so the default overlap is a full 24 h to make sure the re-rolled row
 * is re-fetched on the next tick. Mirrors WHOOP's recovery/sleep overlap.
 */
export const FITBIT_DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a `fullSync` backfill walks. The classic Web API per-endpoint
 * range cap (30 days) means a deep backfill issues many requests against the
 * tight 150/h budget, so the backfill horizon is bounded to keep one user's
 * backfill inside a couple of hourly windows (~12 chunks/resource). One year of
 * daily summaries is the launch horizon.
 */
export const FITBIT_BACKFILL_DAYS = 365;

export interface FitbitTokenInfo {
  accessToken: string;
  connection: { id: string; fitbitUserId: string };
}

/**
 * Resolve a valid Fitbit access token for a user, refreshing if it is within
 * the 5-minute expiry buffer. Returns null when there is no connection, no
 * credentials, or the refresh fails (the failure is recorded so scheduled syncs
 * back off).
 *
 * Classic Fitbit ROTATES refresh tokens (one-time use): every refresh response
 * carries a fresh `refresh_token` that invalidates the old one. Persist the new
 * access token + expiry AND the new refresh token unconditionally. If a refresh
 * response ever omits the new refresh token (a malformed reply), keep the stored
 * one rather than wiping it — a blank refresh token would brick every future
 * refresh.
 */
export async function getValidToken(
  userId: string,
): Promise<FitbitTokenInfo | null> {
  const connection = await prisma.fitbitConnection.findUnique({
    where: { userId },
  });
  if (!connection) return null;

  const accessToken = decrypt(connection.accessToken);
  const refreshToken = decrypt(connection.refreshToken);

  if (
    connection.tokenExpiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS <
    Date.now()
  ) {
    try {
      const creds = await getUserFitbitCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No Fitbit credentials found for user ${userId} during token refresh`,
        );
        await recordSyncFailure({
          userId,
          integration: "fitbit",
          kind: "reauth_required",
          message: "Fitbit credentials missing — token refresh skipped",
          errorCode: "credentials_missing",
        });
        return null;
      }

      const newTokens = await refreshAccessToken(refreshToken, creds);
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      // Classic Fitbit ROTATES refresh tokens: the refresh response carries a
      // fresh `refresh_token` that replaces the (now-invalid) stored one. Persist
      // with a compare-and-swap on the stored ciphertext so a concurrent sync
      // that already rotated the token does not get its work clobbered — and so
      // THIS caller, if it lost the race, reuses the peer's rotated access token
      // instead of parking the connection at reauth. Guard the malformed-reply
      // case: if the response omits the new refresh token, keep the existing one
      // rather than writing a blank, which would brick every future refresh.
      const persistedAccessToken = await persistRotatedToken(
        newTokens.access_token,
        {
          conditionalUpdate: async () => {
            const { count } = await prisma.fitbitConnection.updateMany({
              // `connection.refreshToken` is the exact ciphertext we read +
              // spent; matching it is the CAS guard (a re-encrypt would differ).
              where: {
                id: connection.id,
                refreshToken: connection.refreshToken,
              },
              data: {
                accessToken: encrypt(newTokens.access_token),
                tokenExpiresAt: expiresAt,
                ...(newTokens.refresh_token
                  ? { refreshToken: encrypt(newTokens.refresh_token) }
                  : {}),
              },
            });
            return count;
          },
          readPeerAccessToken: async () => {
            const fresh = await prisma.fitbitConnection.findUnique({
              where: { id: connection.id },
              select: { accessToken: true },
            });
            return fresh ? decrypt(fresh.accessToken) : null;
          },
        },
      );

      if (!persistedAccessToken) return null;

      return {
        accessToken: persistedAccessToken,
        connection: {
          id: connection.id,
          fitbitUserId: connection.fitbitUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(
        `Fitbit token refresh failed for user ${userId}: ${err}`,
      );
      await recordFitbitSyncFailure(userId, err);
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      fitbitUserId: connection.fitbitUserId,
    },
  };
}

/**
 * True when a caught error is a per-endpoint 403 (forbidden). The classic Fitbit
 * scopes are granted independently in the consent flow (and intraday needs an
 * extra per-app grant), so a 403 on ONE endpoint is a scope gate on THAT metric
 * — soft-skip it and keep the connection connected rather than parking the whole
 * integration at `error_reauth`. Connection-wide reauth is reserved for a 401
 * (token rejected) and a 403 on the token-refresh / profile path (a genuine
 * grant revoke), which run outside the per-resource catch blocks. Matters here
 * because partial grants are likely across the independent scopes.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof FitbitApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserFitbit`-cycle counter for collection-403 soft-skips. Scoped by
 * AsyncLocalStorage so the count never bleeds across concurrent per-user
 * pg-boss jobs. Mirrors the WHOOP `softSkipStorage` tracker.
 */
interface SoftSkipTracker {
  count: number;
}
const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Per-`syncUserFitbit`-cycle accumulator of the `(type, day)` keys every
 * resource's writes touched. Only populated on a `fullSync` backfill (when the
 * inline per-day rollup hook is deferred); the orchestrator drains it into ONE
 * `recomputeUserRollups(from, to)` pass at the end of the cycle. Scoped by
 * AsyncLocalStorage so concurrent per-user jobs never cross-pollinate, mirroring
 * the soft-skip tracker.
 */
interface RollupDeferTracker {
  keys: Array<{ type: MeasurementType; measuredAt: Date }>;
}
const rollupDeferStorage = new AsyncLocalStorage<RollupDeferTracker>();

/**
 * Per-cycle ledger of collection fetches that HARD-failed (non-403). A hard
 * failure on one endpoint must not abort its siblings — weight 500ing must not
 * suppress body-fat / spo2 / hrv / rhr / respiratory in the same resource — so
 * `handleCollectionFetchError` records the failure here and RETURNS instead of
 * rethrowing (the old pattern that aborted every endpoint ordered after the bad
 * one and stalled the watermark). The orchestrator reads the ledger to keep the
 * cycle's verdict honest: any entry ⇒ the run counts as failed, so success is
 * NOT stamped and the next tick refetches the window. Ported from Google
 * Health's `hardFailStorage`.
 */
interface HardFailTracker {
  failures: string[];
}
const hardFailStorage = new AsyncLocalStorage<HardFailTracker>();

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync; a
 * soft-skip increments the ambient tracker so `syncUserFitbit` can refuse to
 * stamp success on an all-403 grant-revoke cycle that imported nothing.
 *
 * Anything else records a classified sync failure, notes the collection on the
 * ambient hard-fail ledger, and RETURNS 0 — it does NOT rethrow. Every call site
 * sits in a per-collection catch, so returning lets the sibling endpoints in the
 * same resource keep fetching (one 500 on weight must not kill body-fat / spo2 /
 * hrv / rhr / respiratory), while the ledger still fails the cycle so the
 * watermark is not stamped past the broken collection.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `fitbit ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  await recordFitbitSyncFailure(userId, err);
  getEvent()?.addWarning(`fitbit ${resource} failed for ${userId}: ${err}`);
  const hardTracker = hardFailStorage.getStore();
  if (hardTracker) hardTracker.failures.push(resource);
  return 0;
}

/**
 * Options threaded from `syncUserFitbit` to each per-resource sync. The `start`
 * + `end` window is snapshotted ONCE by the orchestrator (a single `lastSyncedAt`
 * read + a single `now`) so every resource fetches the same window; no resource
 * re-reads `lastSyncedAt` or stamps `markSynced` itself. The per-resource sync
 * chunks `[start, end]` into the per-endpoint date-range cap. The orchestrator
 * owns the single end-of-cycle `markSynced`.
 */
export interface FitbitResourceSyncOptions {
  fullSync?: boolean;
  /** The lower bound of the fetch window, snapshotted once by the orchestrator. */
  start?: Date;
  /** The upper bound of the fetch window (now), snapshotted once. */
  end?: Date;
  /**
   * When true, `upsertFitbitMeasurements` writes the rows but SKIPS the inline
   * per-(type,day) DAY-rollup recompute + status-insight invalidate, returning
   * the touched type-days to the caller instead. The orchestrator collapses
   * them into ONE `recomputeUserRollups(from, to)` pass at the end of a
   * `fullSync` cycle, so a multi-year backfill pays a single range-recompute
   * rather than thousands of per-day round-trips. The incremental path leaves
   * this unset and keeps the inline per-day hook (small touched set, warm read
   * on the next tick).
   */
  deferRollup?: boolean;
}

/**
 * Compute the incremental `start` for a resource sync. `fullSync` walks back the
 * bounded backfill horizon (the classic Web API caps each call's date range, so
 * an unbounded backfill would blow the 150/h budget). Otherwise start from
 * `lastSyncedAt - overlap`, or 30 days back on the very first incremental tick.
 */
export function incrementalStart(
  lastSyncedAt: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number; now?: Date } = {},
): Date {
  const now = opts.now ?? new Date();
  if (opts.fullSync) {
    return new Date(now.getTime() - FITBIT_BACKFILL_DAYS * 24 * 60 * 60 * 1000);
  }
  const overlap = opts.overlapMs ?? FITBIT_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * Slice `[start, end]` into consecutive inclusive windows no wider than
 * `maxDays` calendar days, the per-endpoint range cap the classic Web API
 * enforces. Each window is `{ start, end }` with `end` no later than the overall
 * `end`; the per-resource syncs issue one request per window. Returns a single
 * window when the span already fits.
 */
export function chunkDateRanges(
  start: Date,
  end: Date,
  maxDays: number,
): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  if (end.getTime() < start.getTime()) return windows;
  const stepMs = maxDays * 24 * 60 * 60 * 1000;
  let cursor = start.getTime();
  const endMs = end.getTime();
  // Guard against a pathological span minting an unbounded loop.
  let guard = 0;
  const MAX_WINDOWS = 1000;
  while (cursor <= endMs && guard < MAX_WINDOWS) {
    // Each window spans up to `maxDays` days inclusive, so subtract one day from
    // the step to keep the inclusive end inside the cap.
    const windowEnd = Math.min(cursor + stepMs - 24 * 60 * 60 * 1000, endMs);
    windows.push({ start: new Date(cursor), end: new Date(windowEnd) });
    cursor = windowEnd + 24 * 60 * 60 * 1000;
    guard += 1;
  }
  return windows;
}

/**
 * One mapped reading destined for a `Measurement` row, with the per-point anchor
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<anchor>:<fieldTag>`). Mirrors WHOOP's
 * `WhoopMeasurementUpsert` (no `sleepStage` — sleep lands in W5).
 */
export interface FitbitMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  /**
   * Per-stage sleep rows carry the `SleepStage` axis so the (up to six) stage
   * rows for one night stay distinct under the dedup key; every other row omits
   * it (null). W5 (sleep) is the only producer.
   */
  sleepStage?: "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP" | null;
}

/** Chunk size for the batched `createMany` insert of fresh readings. */
const FITBIT_CREATE_CHUNK = 500;

/**
 * Write a batch of mapped Fitbit readings for one user and (unless deferred)
 * fold the rollup tier + invalidate status-insight caches once at the end
 * (mirrors the WHOOP / Withings sync tail). Returns the count of rows written
 * plus the distinct `(type, day)` keys the write touched.
 *
 * TOMBSTONE-SAFE: the live-row probe filters `deletedAt: null`, so a row the
 * user soft-deleted (iOS LWW reconciler) is NOT matched — a fresh insert is
 * created instead of resurrecting the tombstone on the next hourly sync. The
 * partial unique index (`Measurement … WHERE deleted_at IS NULL`) keeps the
 * fresh insert from colliding with the live set; the tombstone sits outside it.
 *
 * OVERWRITE CONTRACT preserved: a re-fetched daily summary (`stats:`-keyed and
 * every other stable per-point anchor) maps to the SAME live `externalId`, so
 * the probe finds the existing live row and takes the in-place update branch
 * (bumping `syncVersion` for the iOS LWW reconciler) — never a duplicate.
 *
 * BATCHING: the existence probe is a single `findMany` over the batch's
 * externalIds; fresh rows go through chunked `createMany` (collapsing the N+1
 * insert round-trips a deep backfill used to pay), and only the (bounded)
 * already-live rows take a per-row `update` for their differing values.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup never
 * fails the user's sync.
 */
export async function upsertFitbitMeasurements(
  userId: string,
  readings: FitbitMeasurementUpsert[],
  opts: { deferRollup?: boolean } = {},
): Promise<{
  imported: number;
  touched: Array<{ type: MeasurementType; measuredAt: Date }>;
}> {
  if (readings.length === 0) return { imported: 0, touched: [] };

  // Probe the LIVE rows (deletedAt: null) for every externalId in the batch in
  // a single query. A tombstoned row deliberately does NOT appear here, so it is
  // treated as absent → a fresh insert, not a resurrecting update.
  const externalIds = readings.map((r) => r.externalId);
  let liveByKey = new Map<string, { id: string }>();
  try {
    const existing = await prisma.measurement.findMany({
      where: {
        userId,
        source: "FITBIT",
        deletedAt: null,
        externalId: { in: externalIds },
      },
      select: { id: true, type: true, externalId: true },
    });
    liveByKey = new Map(
      existing
        .filter((e) => e.externalId !== null)
        .map((e) => [
          `${e.type}${DEDUP_KEY_DELIM}${e.externalId}`,
          { id: e.id },
        ]),
    );
  } catch (err) {
    // A probe failure must not strand the whole batch; fall back to treating
    // every row as fresh (the partial unique index still rejects a genuine
    // live-row collision, which the per-create catch swallows).
    getEvent()?.addWarning(`Fitbit: live-row probe failed: ${err}`);
  }

  const toCreate: Array<{
    type: MeasurementType;
    value: number;
    unit: string;
    measuredAt: Date;
    externalId: string;
    sleepStage: FitbitMeasurementUpsert["sleepStage"];
  }> = [];
  const toUpdate: Array<{ id: string; r: FitbitMeasurementUpsert }> = [];
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  // A batch can carry the same (type, externalId) twice (an overlap re-fetch);
  // collapse to last-write-wins so we never emit two creates for one live key.
  const plannedCreateKeys = new Set<string>();
  for (const r of readings) {
    const type = r.type as MeasurementType;
    const key = `${type}${DEDUP_KEY_DELIM}${r.externalId}`;
    const live = liveByKey.get(key);
    if (live) {
      toUpdate.push({ id: live.id, r });
    } else if (!plannedCreateKeys.has(key)) {
      plannedCreateKeys.add(key);
      toCreate.push({
        type,
        value: r.value,
        unit: r.unit,
        measuredAt: r.measuredAt,
        externalId: r.externalId,
        sleepStage: r.sleepStage ?? null,
      });
    } else {
      // A duplicate fresh key inside the same batch — overwrite the planned
      // create's payload so last-write-wins, matching the prior upsert loop.
      const idx = toCreate.findIndex(
        (c) => `${c.type}${DEDUP_KEY_DELIM}${c.externalId}` === key,
      );
      if (idx >= 0) {
        toCreate[idx] = {
          type,
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          externalId: r.externalId,
          sleepStage: r.sleepStage ?? null,
        };
      }
    }
  }

  let imported = 0;

  // Fresh inserts: chunked `createMany` (server-owned rows, field-by-field).
  // `skipDuplicates` guards the partial-unique index in the rare race where a
  // concurrent run inserted the same live key between the probe and the write.
  for (let i = 0; i < toCreate.length; i += FITBIT_CREATE_CHUNK) {
    const chunk = toCreate.slice(i, i + FITBIT_CREATE_CHUNK);
    try {
      const res = await prisma.measurement.createMany({
        data: chunk.map((c) => ({
          userId,
          type: c.type,
          source: "FITBIT" as const,
          value: c.value,
          unit: c.unit,
          measuredAt: c.measuredAt,
          externalId: c.externalId,
          sleepStage: c.sleepStage,
        })),
        skipDuplicates: true,
      });
      imported += res.count;
      for (const c of chunk) {
        touched.push({ type: c.type, measuredAt: c.measuredAt });
      }
    } catch (err) {
      getEvent()?.addWarning(`Fitbit: failed to create measurements: ${err}`);
    }
  }

  // Live-row overwrites: per-row update (differing values) on the live id, so
  // the re-fetched daily summary overwrites in place and bumps `syncVersion`.
  for (const { id, r } of toUpdate) {
    try {
      await prisma.measurement.update({
        where: { id },
        data: {
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          sleepStage: r.sleepStage ?? null,
          // Surface the server-side mutation to the iOS LWW reconciler.
          syncVersion: { increment: 1 },
        },
      });
      touched.push({
        type: r.type as MeasurementType,
        measuredAt: r.measuredAt,
      });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`Fitbit: failed to update measurement: ${err}`);
    }
  }

  // On a `fullSync` backfill the caller defers the rollup fold: it collapses
  // every resource's touched type-days into a SINGLE range-recompute at the end
  // of the cycle (thousands of per-day round-trips → one pass). The incremental
  // path keeps the inline per-day hook here (small touched set, warm next read).
  if (opts.deferRollup) {
    const tracker = rollupDeferStorage.getStore();
    if (tracker) tracker.keys.push(...touched);
    return { imported, touched };
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
        `fitbit: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `fitbit: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return { imported, touched };
}

/**
 * Stamp `lastSyncedAt = now`. Called ONCE per cycle by `syncUserFitbit` after a
 * non-degenerate run — never per resource, so the watermark can't move mid-cycle
 * and shrink a later resource's fetch window.
 */
export async function markSynced(userId: string): Promise<void> {
  await prisma.fitbitConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * Full per-user sync across every Fitbit resource. Drives the hourly poll
 * catch-all, the manual `/api/fitbit/sync` trigger, and the boot-time backfill
 * (`fullSync: true`). Poll-only — there is no Fitbit webhook at launch (Pub/Sub
 * deferred), so there is no per-resource webhook enqueue path.
 *
 * Parks immediately when the connection is at `error_reauth` (the user must
 * reconnect first) — returns 0, matching the WHOOP / Withings no-op contract.
 *
 * Resources: health-metrics (W3), daily-cumulative activity, per-stage sleep,
 * and exercise workouts (W5). Each runs independently so a per-resource 403
 * (a Restricted bundle the user did not grant) soft-skips only that resource.
 *
 * WATERMARK: the incremental `[start, end]` window is snapshotted ONCE here
 * (from the single `lastSyncedAt` read + a single `now` at the top of the cycle)
 * and threaded to every resource, and `markSynced` is stamped ONCE at the end. A
 * per-resource read+stamp would let the first resource move `lastSyncedAt` to
 * now() so later resources only see the last overlap window — silently dropping
 * the gap after an outage longer than the overlap. The full/backfill path passes
 * `fullSync: true`, which widens `start` back to the bounded backfill horizon.
 */
export async function syncUserFitbit(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  if (await isReauthRequired(userId, "fitbit")) {
    getEvent()?.addWarning(
      `fitbit sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  // Snapshot the incremental window ONCE for the whole cycle. Every resource
  // sees the same `[start, end]`; no resource re-reads `lastSyncedAt` mid-cycle.
  // A full/backfill run widens `start` back to the bounded backfill horizon.
  const connection = await prisma.fitbitConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) return 0;
  const end = new Date();
  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
    now: end,
  });
  const resourceOpts: FitbitResourceSyncOptions = {
    fullSync: opts.fullSync,
    start,
    end,
    // A backfill walks years of daily summaries — defer the per-(type,day)
    // rollup hook on every write and run ONE range-recompute at the end of the
    // cycle. The hourly incremental keeps the inline hook (small touched set).
    deferRollup: opts.fullSync === true,
  };

  const [
    { syncUserMetrics },
    { syncUserActivity },
    { syncUserSleep },
    { syncUserWorkout },
  ] = await Promise.all([
    import("./sync-metrics"),
    import("./sync-activity"),
    import("./sync-sleep"),
    import("./sync-workout"),
  ]);

  const resources = [
    syncUserMetrics,
    syncUserActivity,
    syncUserSleep,
    syncUserWorkout,
  ];

  const tracker: SoftSkipTracker = { count: 0 };
  const deferTracker: RollupDeferTracker = { keys: [] };
  const hardFailTracker: HardFailTracker = { failures: [] };
  let total = 0;
  let anyFailed = false;
  await softSkipStorage.run(tracker, async () => {
    await hardFailStorage.run(hardFailTracker, async () => {
      await rollupDeferStorage.run(deferTracker, async () => {
        for (const fn of resources) {
          try {
            total += await fn(userId, resourceOpts);
          } catch (err) {
            anyFailed = true;
            getEvent()?.addWarning(
              `fitbit ${fn.name} failed for ${userId}: ${err}`,
            );
          }
        }
      });
    });
  });
  // A collection that hard-failed inside a resource (recorded on the ledger by
  // `handleCollectionFetchError` without aborting its siblings) still fails the
  // cycle: partial error, no watermark stamp.
  if (hardFailTracker.failures.length > 0) anyFailed = true;

  // On a `fullSync` backfill the per-write inline rollup hook was deferred; the
  // accumulated touched type-days collapse into ONE range-recompute spanning the
  // touched days. One pass replaces the thousands of per-(type,day) round-trips a
  // deep backfill would otherwise pay (each = an aggregate SELECT + rollup upsert
  // + 3 queue sends). Best-effort: a populator hiccup never fails the backfill.
  if (opts.fullSync && deferTracker.keys.length > 0) {
    try {
      const days = collapseToTypeDayKeys(deferTracker.keys);
      const types = Array.from(new Set(days.map((k) => k.type)));
      const sorted = days
        .map((k) => k.measuredAt.getTime())
        .sort((a, b) => a - b);
      const from = new Date(sorted[0]!);
      // The keys are UTC day-starts; extend `to` past the last touched day so
      // the aggregator's `< to` upper bound covers it.
      const to = new Date(sorted[sorted.length - 1]! + 24 * 60 * 60 * 1000);
      await recomputeUserRollups(userId, { types, from, to });
      invalidateStatusInsightsForTypes(userId, types).catch((err) => {
        getEvent()?.addWarning(
          `fitbit: status-insight invalidate failed for ${userId}: ${err}`,
        );
      });
    } catch (err) {
      getEvent()?.addWarning(
        `fitbit: backfill rollup recompute failed for ${userId}: ${err}`,
      );
    }
  }

  // A genuine grant-revoke 403s EVERY collection: each resource soft-skips
  // (returns 0, records no failure), so `anyFailed` stays false and `total` is
  // 0 — yet the connection is dead until the token-refresh path next catches the
  // 401. Don't stamp success when the whole cycle was soft-skipped and nothing
  // imported; leave the status as-is so the "looks-healthy" window closes. A
  // partial cycle (some rows imported, or at least one resource that did not
  // soft-skip) stamps success as normal.
  const allSoftSkipped = tracker.count >= resources.length && total === 0;

  if (!anyFailed && !allSoftSkipped) {
    // Stamp the watermark ONCE for the whole cycle, only on a non-degenerate
    // run. Every resource already saw the snapshot `start`, so stamping now()
    // here can't shrink a later resource's window.
    await markSynced(userId);
    await recordSyncSuccess(userId, "fitbit");
  }

  annotate({
    action: { name: "fitbit.sync", details: { imported: total } },
  });
  return total;
}

/**
 * Map a Fitbit response classification onto a `FailureKind` and record it.
 * Shared by the token-refresh path and every per-resource catch block.
 */
export async function recordFitbitSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "fitbit",
    kind: classificationToFailureKind(classifyFitbitError(err)),
    message,
    errorCode:
      err instanceof FitbitApiError ? err.httpStatus?.toString() : undefined,
  });
}

export function classificationToFailureKind(
  classification: FitbitClassification,
): FailureKind {
  switch (classification) {
    case "reauth_required":
      return "reauth_required";
    case "persistent":
      return "persistent";
    case "transient":
      return "transient";
    case "success":
      // A caller asking for the FailureKind of a success is a contract bug;
      // surface it as transient so the audit log still records the anomaly.
      return "transient";
  }
}

/**
 * Bounded fan-out width for the hourly Fitbit cohort poll. The cron tick carries
 * no `userId`, so the worker resolves every connection and hands the cohort here.
 * A small pool (rather than a strict serial loop) means one slow Fitbit response
 * can't stall the whole cohort, while the cap keeps the burst of per-user
 * resource fetches + rollup writes from crowding the worker's DB pool.
 *
 * Tuned to 2 for the classic Web API: each per-user cycle issues ~a dozen
 * date-range requests against a tight 150 req/h-per-user budget, so a narrower
 * pool keeps the concurrent outbound burst (and the DB-write tail behind it)
 * modest. The per-user budget is independent, so the cap is about worker
 * pressure, not the API ceiling — but 2 keeps both comfortable.
 */
export const FITBIT_POLL_CONCURRENCY = 2;

/**
 * Run a Fitbit hourly-poll cohort with bounded concurrency + per-user error
 * isolation. Each user's `syncUserFitbit` runs inside the pool; a single user's
 * failure (or a slow Google response) is captured through `onUserError` and never
 * aborts the rest of the pass. Returns the per-cohort totals for the wide-event
 * envelope. Extracted from the worker handler so the concurrency contract is unit
 * testable without exporting worker internals.
 */
export async function runFitbitPollCohort(
  userIds: string[],
  opts: {
    concurrency?: number;
    sync?: (userId: string) => Promise<number>;
    onUserError?: (userId: string, err: unknown) => void;
    /** v1.18.1 — invoked after a user's sync lands `imported` measurements,
     *  so the worker can fire the eventful Vorsorge satisfaction enqueue
     *  without the fitbit lib reaching into the job layer. */
    onUserSynced?: (userId: string, imported: number) => void;
  } = {},
): Promise<{ usersSynced: number; measurementsImported: number }> {
  const sync = opts.sync ?? ((userId: string) => syncUserFitbit(userId));
  const limit = pLimit(opts.concurrency ?? FITBIT_POLL_CONCURRENCY);

  let usersSynced = 0;
  let measurementsImported = 0;
  await Promise.all(
    userIds.map((userId) =>
      limit(async () => {
        try {
          // Read the accumulators AFTER the await resolves. A compound
          // assignment (`x += await f()`) captures the left value BEFORE the
          // await and would lose increments under overlapping pool tasks.
          const n = await sync(userId);
          measurementsImported = measurementsImported + n;
          usersSynced = usersSynced + 1;
          opts.onUserSynced?.(userId, n);
        } catch (err) {
          opts.onUserError?.(userId, err);
        }
      }),
    ),
  );

  return { usersSynced, measurementsImported };
}
