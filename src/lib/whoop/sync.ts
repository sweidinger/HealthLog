/**
 * WHOOP sync service — token refresh (rotating refresh token), the shared
 * Measurement upsert/rollup-fold tail, and the per-resource sync entry points.
 *
 * Mirrors `src/lib/withings/sync.ts`:
 *   - `getValidToken` decrypts the stored pair, refreshes at
 *     `tokenExpiresAt - 5 min`, and persists BOTH rotated tokens (WHOOP
 *     invalidates the prior access AND refresh token on every refresh — the
 *     same discipline Withings uses for its rotating refresh token).
 *   - Each per-resource sync (`sync-recovery` / `sync-sleep` / `sync-cycle` /
 *     `sync-workout`) upserts into `Measurement` / `Workout` keyed on
 *     `(userId, type, source = WHOOP, externalId)` so a re-post (WHOOP
 *     re-scores recovery/sleep after the fact) overwrites in place rather than
 *     minting a duplicate. After the upserts the rollup tier is re-folded
 *     (`recomputeBucketsForMeasurement`) and the status-insight caches are
 *     invalidated, identical to the Withings tail.
 *
 * The incremental window starts from `lastSyncedAt - overlap`. WHOOP re-scores
 * recovery/sleep hours after the night, so the overlap must comfortably cover
 * the re-score lag — `WHOOP_RECOVERY_SLEEP_OVERLAP_MS` is 24 h; workout/cycle
 * use the smaller `WHOOP_DEFAULT_OVERLAP_MS`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { encrypt, decrypt } from "@/lib/crypto";
import { getEvent } from "@/lib/logging/context";
import {
  isReauthRequired,
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { refreshAccessToken } from "./client";
import { getUserWhoopCredentials } from "./credentials";
import {
  WhoopApiError,
  classifyWhoopError,
  type WhoopClassification,
} from "./response-classifier";

/**
 * True when a caught error is a per-resource collection 403 (forbidden). A 403
 * on a single data class is a tier/scope gate on THAT class — the right
 * response is to soft-skip the class and keep the connection connected, NOT to
 * park the whole integration at `error_reauth`. Reserve connection-wide reauth
 * for a 401 (token rejected) and for a 403 on the token-refresh / profile path
 * (a genuine grant revoke), which run outside the per-resource catch blocks.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof WhoopApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserWhoop`-cycle counter for collection-403 soft-skips. Set up by
 * `syncUserWhoop` around the resource loop so the per-resource catch blocks —
 * which return a bare 0 on a soft-skip, indistinguishable from a genuine
 * "no new records" — can be told apart from the orchestrator. AsyncLocalStorage
 * keeps the count scoped to one user's sync, never bleeding across concurrent
 * per-user pg-boss jobs.
 */
interface SoftSkipTracker {
  count: number;
}
const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync;
 * anything else records a classified sync failure and rethrows. Call as
 * `return handleCollectionFetchError("recovery", userId, err)` from a resource
 * sync's catch block.
 *
 * A soft-skip increments the ambient `softSkipStorage` tracker (when present)
 * so `syncUserWhoop` can refuse to stamp success on an all-403 grant-revoke
 * cycle that imported nothing.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `whoop ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  await recordWhoopSyncFailure(userId, err);
  throw err;
}

/** Refresh the access token this many ms before `tokenExpiresAt`. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Overlap window for the incremental sync, in ms. WHOOP re-scores recovery
 * and sleep after the fact, and a night can reach the WHOOP cloud DAYS late
 * (phone offline, app unopened, score pending). The collection endpoints
 * filter on the record's own time range — not on when it arrived — so any
 * record surfacing after the cursor moved past it is missed FOREVER by a
 * narrow overlap; the night's per-stage rows then never reach the DB and
 * every sleep surface keeps showing the parallel coarse source for that
 * night. Seven days re-fetches a handful of records per tick (the upserts
 * are idempotent) and closes the gap for every realistic lag. Workout/cycle
 * settle fast — a smaller overlap suffices and keeps the page count down.
 */
export const WHOOP_RECOVERY_SLEEP_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
export const WHOOP_DEFAULT_OVERLAP_MS = 60 * 60 * 1000; // 1 h

export interface WhoopTokenInfo {
  accessToken: string;
  connection: { id: string; whoopUserId: string };
}

/**
 * Resolve a valid WHOOP access token for a user, refreshing if it is within
 * the 5-minute expiry buffer. On refresh, persists BOTH rotated tokens.
 * Returns null when there is no connection, no credentials, or the refresh
 * fails (the failure is recorded so scheduled syncs back off).
 */
export async function getValidToken(
  userId: string,
): Promise<WhoopTokenInfo | null> {
  const connection = await prisma.whoopConnection.findUnique({
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
      const creds = await getUserWhoopCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No WHOOP credentials found for user ${userId} during token refresh`,
        );
        await recordSyncFailure({
          userId,
          integration: "whoop",
          kind: "reauth_required",
          message: "WHOOP credentials missing — token refresh skipped",
          errorCode: "credentials_missing",
        });
        return null;
      }

      const newTokens = await refreshAccessToken(refreshToken, creds);
      const expiresAt = new Date(Date.now() + newTokens.expires_in * 1000);

      // WHOOP rotates the refresh token on every refresh — persist BOTH the
      // new access token AND the new refresh token, or the next refresh
      // reuses an invalidated token and the connection drops to reauth.
      await prisma.whoopConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(newTokens.access_token),
          refreshToken: encrypt(newTokens.refresh_token),
          tokenExpiresAt: expiresAt,
        },
      });

      return {
        accessToken: newTokens.access_token,
        connection: {
          id: connection.id,
          whoopUserId: connection.whoopUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(
        `WHOOP token refresh failed for user ${userId}: ${err}`,
      );
      await recordWhoopSyncFailure(userId, err);
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      whoopUserId: connection.whoopUserId,
    },
  };
}

/**
 * Compute the incremental `start` for a resource sync. `fullSync` returns
 * undefined (the backfill anchor handles the deep history). Otherwise start
 * from `lastSyncedAt - overlap`, or 30 days back on the very first incremental
 * tick.
 */
export function incrementalStart(
  lastSyncedAt: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number } = {},
): Date | undefined {
  if (opts.fullSync) return undefined;
  const overlap = opts.overlapMs ?? WHOOP_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * One mapped reading destined for a `Measurement` row, with the resource uuid
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<resource-uuid>:<fieldTag>`).
 */
export interface WhoopMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  sleepStage?: "CORE" | "DEEP" | "REM" | "AWAKE" | "IN_BED" | null;
}

/**
 * Upsert a batch of mapped WHOOP readings for one user and fold the rollup
 * tier + invalidate status-insight caches once at the end (mirrors the
 * Withings sync tail). Idempotent: the `(userId, type, source, externalId)`
 * unique key makes a re-post (WHOOP re-score) overwrite in place. Returns the
 * count of rows written.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup
 * never fails the user's sync.
 */
export async function upsertWhoopMeasurements(
  userId: string,
  readings: WhoopMeasurementUpsert[],
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
            source: "WHOOP",
            externalId: r.externalId,
          },
        },
        create: {
          userId,
          type,
          source: "WHOOP",
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
          // Surface the server-side mutation to the iOS LWW reconciler.
          syncVersion: { increment: 1 },
        },
      });
      touched.push({ type, measuredAt: r.measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`WHOOP: failed to upsert measurement: ${err}`);
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
        `whoop: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `whoop: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return imported;
}

/** Stamp `lastSyncedAt = now` after a successful resource sync. */
export async function markSynced(userId: string): Promise<void> {
  await prisma.whoopConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * Full per-user sync across every WHOOP resource. Webhook-driven syncs enqueue
 * a single per-resource job; this drives the hourly poll catch-all and the
 * manual `/api/whoop/sync` trigger.
 *
 * Parks immediately when the connection is at `error_reauth` (the user must
 * reconnect first) — returns 0, matching the Withings no-op contract.
 */
export async function syncUserWhoop(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  if (await isReauthRequired(userId, "whoop")) {
    getEvent()?.addWarning(
      `whoop sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const { syncUserRecovery } = await import("./sync-recovery");
  const { syncUserSleep } = await import("./sync-sleep");
  const { syncUserCycle } = await import("./sync-cycle");
  const { syncUserWorkout } = await import("./sync-workout");
  const { syncUserBody } = await import("./sync-body");

  const resources = [
    syncUserRecovery,
    syncUserSleep,
    syncUserCycle,
    syncUserWorkout,
    syncUserBody,
  ];

  const tracker: SoftSkipTracker = { count: 0 };
  let total = 0;
  let anyFailed = false;
  await softSkipStorage.run(tracker, async () => {
    for (const fn of resources) {
      try {
        total += await fn(userId, opts);
      } catch (err) {
        anyFailed = true;
        getEvent()?.addWarning(`whoop ${fn.name} failed for ${userId}: ${err}`);
      }
    }
  });

  // A genuine grant-revoke 403s EVERY collection: each resource soft-skips
  // (returns 0, records no failure), so `anyFailed` stays false and `total` is
  // 0 — yet the connection is dead until the token-refresh path next catches
  // the 401 (up to ~1 h later). Don't stamp success when the whole cycle was
  // soft-skipped and nothing imported; leave the status as-is so the
  // "looks-healthy" window closes. A partial cycle (some rows imported, or at
  // least one resource that did not soft-skip) stamps success as normal.
  const allSoftSkipped =
    tracker.count >= resources.length && total === 0;

  if (!anyFailed && !allSoftSkipped) {
    await recordSyncSuccess(userId, "whoop");
  }
  return total;
}

/**
 * Map a WHOOP response classification onto a `FailureKind` and record it.
 * Shared by every per-resource catch-block and the token-refresh path.
 */
export async function recordWhoopSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: "whoop",
    kind: classificationToFailureKind(classifyWhoopError(err)),
    message,
    errorCode:
      err instanceof WhoopApiError ? err.httpStatus?.toString() : undefined,
  });
}

export function classificationToFailureKind(
  classification: WhoopClassification,
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
