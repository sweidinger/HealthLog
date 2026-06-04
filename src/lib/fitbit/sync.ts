/**
 * Fitbit / Google Health sync service (v1.12.0).
 *
 * This wave (OAuth + credentials) lands the token-management half:
 *   - `getValidToken` decrypts the stored token, refreshes at
 *     `tokenExpiresAt - 5 min`, persists the new access token + expiry, and —
 *     UNLIKE WHOOP — only overwrites the stored refresh token when the response
 *     carries a fresh one (Google does not rotate refresh tokens).
 *   - `recordFitbitSyncFailure` / `classificationToFailureKind` map a
 *     classified API error onto the shared integration-status ledger.
 *
 * The per-resource data sync (`upsertFitbitMeasurements`, `syncUserFitbit`, the
 * collection walkers, and the 403 soft-skip orchestration) lands in a later
 * wave and extends this file.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
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
 * Overlap window for the incremental sync, in ms. Google re-rolls daily
 * summaries after the fact (a daily SpO2 / HRV / RHR can finalise hours after
 * the night), so the default overlap is a full 24 h to make sure the re-rolled
 * row is re-fetched on the next tick. Mirrors WHOOP's recovery/sleep overlap.
 */
export const FITBIT_DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

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
 * KEY DELTA vs WHOOP: Google does not rotate refresh tokens. On refresh, persist
 * the new access token + expiry and overwrite the stored `refreshToken` ONLY
 * when the response carries a fresh one — otherwise keep the existing refresh
 * token so the next refresh still authenticates.
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

      // Google does NOT rotate refresh tokens: a routine refresh returns a new
      // access token but usually omits `refresh_token`. Persist the new access
      // token + expiry and only overwrite the stored refresh token when the
      // response actually carries a fresh one — otherwise keep the existing one.
      await prisma.fitbitConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: encrypt(newTokens.access_token),
          tokenExpiresAt: expiresAt,
          ...(newTokens.refresh_token
            ? { refreshToken: encrypt(newTokens.refresh_token) }
            : {}),
        },
      });

      return {
        accessToken: newTokens.access_token,
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
 * True when a caught error is a per-data-class 403 (forbidden). The six Google
 * Health Restricted bundles are granted independently in the consent flow, so a
 * 403 on ONE data class is a scope gate on THAT class — soft-skip it and keep
 * the connection connected rather than parking the whole integration at
 * `error_reauth`. Connection-wide reauth is reserved for a 401 (token rejected)
 * and for a 403 on the token-refresh / profile path (a genuine grant revoke),
 * which run outside the per-resource catch blocks. Matters more here than for
 * WHOOP because partial grants are likely with six independent bundles.
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
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync;
 * anything else records a classified sync failure and rethrows. A soft-skip
 * increments the ambient tracker so `syncUserFitbit` can refuse to stamp success
 * on an all-403 grant-revoke cycle that imported nothing.
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
  throw err;
}

/**
 * Compute the incremental `start` for a resource sync. `fullSync` returns
 * undefined (the backfill walks deep history without a lower bound). Otherwise
 * start from `lastSyncedAt - overlap`, or 30 days back on the very first
 * incremental tick. Mirrors WHOOP's `incrementalStart`.
 */
export function incrementalStart(
  lastSyncedAt: Date | null,
  opts: { fullSync?: boolean; overlapMs?: number } = {},
): Date | undefined {
  if (opts.fullSync) return undefined;
  const overlap = opts.overlapMs ?? FITBIT_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
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
}

/**
 * Upsert a batch of mapped Fitbit readings for one user and fold the rollup tier
 * + invalidate status-insight caches once at the end (mirrors the WHOOP / Withings
 * sync tail). Idempotent: the `(userId, type, source, externalId)` unique key
 * makes a re-post (a re-fetched daily summary) overwrite in place rather than
 * minting a duplicate. Returns the count of rows written.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup never
 * fails the user's sync.
 */
export async function upsertFitbitMeasurements(
  userId: string,
  readings: FitbitMeasurementUpsert[],
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
            source: "FITBIT",
            externalId: r.externalId,
          },
        },
        create: {
          userId,
          type,
          source: "FITBIT",
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          externalId: r.externalId,
        },
        update: {
          value: r.value,
          unit: r.unit,
          measuredAt: r.measuredAt,
          // Surface the server-side mutation to the iOS LWW reconciler.
          syncVersion: { increment: 1 },
        },
      });
      touched.push({ type, measuredAt: r.measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`Fitbit: failed to upsert measurement: ${err}`);
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
        `fitbit: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `fitbit: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return imported;
}

/** Stamp `lastSyncedAt = now` after a successful resource sync. */
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
 * W3 wires the health-metrics resource; activity / sleep / workout join the
 * resource list in W5.
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

  const { syncUserMetrics } = await import("./sync-metrics");

  const resources = [syncUserMetrics];

  const tracker: SoftSkipTracker = { count: 0 };
  let total = 0;
  let anyFailed = false;
  await softSkipStorage.run(tracker, async () => {
    for (const fn of resources) {
      try {
        total += await fn(userId, opts);
      } catch (err) {
        anyFailed = true;
        getEvent()?.addWarning(`fitbit ${fn.name} failed for ${userId}: ${err}`);
      }
    }
  });

  // A genuine grant-revoke 403s EVERY collection: each resource soft-skips
  // (returns 0, records no failure), so `anyFailed` stays false and `total` is
  // 0 — yet the connection is dead until the token-refresh path next catches the
  // 401. Don't stamp success when the whole cycle was soft-skipped and nothing
  // imported; leave the status as-is so the "looks-healthy" window closes. A
  // partial cycle (some rows imported, or at least one resource that did not
  // soft-skip) stamps success as normal.
  const allSoftSkipped = tracker.count >= resources.length && total === 0;

  if (!anyFailed && !allSoftSkipped) {
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
