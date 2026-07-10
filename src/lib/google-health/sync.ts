/**
 * Google Health sync service (v1.27.0).
 *
 * Token-management + per-resource orchestration:
 *   - `getValidToken` decrypts the stored token, refreshes at
 *     `tokenExpiresAt - 5 min`, persists the new access token + expiry, and —
 *     following Google's semantics — only overwrites the stored refresh token
 *     when the response carries a fresh one (Google does NOT rotate refresh
 *     tokens). A revoked / expired refresh token (the 7-day "Testing"-mode
 *     expiry, or a user-revoked grant) surfaces `invalid_grant`/401 →
 *     `reauth_required`, which parks the connection at `error_reauth` so the
 *     card prompts a reconnect.
 *   - `recordGoogleHealthSyncFailure` / `classificationToFailureKind` map a
 *     classified API error onto the shared integration-status ledger.
 *   - `syncUserGoogleHealth` drives the hourly poll, the manual trigger, and the
 *     boot-time backfill across every resource.
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
import { refreshAccessToken } from "./client";
import { getUserGoogleHealthCredentials } from "./credentials";
import {
  GoogleHealthApiError,
  classifyGoogleHealthError,
  isGoogleHealthReauthRequired,
  type GoogleHealthClassification,
} from "./response-classifier";

/**
 * The status-ledger key for this integration. Distinct from the classic Fitbit
 * `"fitbit"` key so the two coexisting providers keep independent status rows.
 */
export const GOOGLE_HEALTH_INTEGRATION_KEY = "google-health";

/** Refresh the access token this many ms before `tokenExpiresAt`. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Overlap window for the incremental sync, in ms. Google re-rolls daily
 * summaries after the fact (a daily SpO2 / HRV / RHR can finalise hours after
 * the night), so the default overlap is a full 24 h to make sure the re-rolled
 * row is re-fetched on the next tick. Mirrors WHOOP's recovery/sleep overlap.
 */
export const GOOGLE_HEALTH_DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000;

export interface GoogleHealthTokenInfo {
  accessToken: string;
  connection: { id: string; googleUserId: string };
}

/**
 * Resolve a valid Google Health access token for a user, refreshing if it is
 * within the 5-minute expiry buffer. Returns null when there is no connection,
 * no credentials, or the refresh fails (the failure is recorded so scheduled
 * syncs back off).
 *
 * Google does not rotate refresh tokens. On refresh, persist the new access
 * token + expiry and overwrite the stored `refreshToken` ONLY when the response
 * carries a fresh one — otherwise keep the existing refresh token so the next
 * refresh still authenticates.
 */
export async function getValidToken(
  userId: string,
): Promise<GoogleHealthTokenInfo | null> {
  const connection = await prisma.googleHealthConnection.findUnique({
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
      const creds = await getUserGoogleHealthCredentials(userId);
      if (!creds) {
        getEvent()?.addWarning(
          `No Google Health credentials found for user ${userId} during token refresh`,
        );
        await recordSyncFailure({
          userId,
          integration: GOOGLE_HEALTH_INTEGRATION_KEY,
          kind: "reauth_required",
          message: "Google Health credentials missing — token refresh skipped",
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
      await prisma.googleHealthConnection.update({
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
          googleUserId: connection.googleUserId,
        },
      };
    } catch (err) {
      getEvent()?.addWarning(
        `Google Health token refresh failed for user ${userId}: ${err}`,
      );
      // A revoked / expired refresh token (`invalid_grant` / 401 — the 7-day
      // Testing-mode refresh expiry, or a user-revoked grant) is a SOFT
      // disconnect: flag `needsReauth` on the connection so the card surfaces a
      // "reconnect" CTA rather than a hard error. The callback clears it on a
      // fresh consent. A transient refresh failure (network blip, 5xx) leaves
      // the flag untouched so we don't nag the user to reconnect needlessly.
      if (isGoogleHealthReauthRequired(err)) {
        await prisma.googleHealthConnection
          .update({
            where: { id: connection.id },
            data: { needsReauth: true },
          })
          .catch((e) =>
            getEvent()?.addWarning(
              `google-health: needsReauth flag write failed for ${userId}: ${e}`,
            ),
          );
      }
      await recordGoogleHealthSyncFailure(userId, err);
      return null;
    }
  }

  return {
    accessToken,
    connection: {
      id: connection.id,
      googleUserId: connection.googleUserId,
    },
  };
}

/**
 * True when a caught error is a per-data-class 403 (forbidden). The Google
 * Health Restricted bundles are granted independently in the consent flow, so a
 * 403 on ONE data class is a scope gate on THAT class — soft-skip it and keep
 * the connection connected rather than parking the whole integration at
 * `error_reauth`. Connection-wide reauth is reserved for a 401 (token rejected)
 * and for a 403 on the token-refresh / profile path (a genuine grant revoke),
 * which run outside the per-resource catch blocks.
 */
export function isCollectionForbidden(err: unknown): boolean {
  return err instanceof GoogleHealthApiError && err.httpStatus === 403;
}

/**
 * Per-`syncUserGoogleHealth`-cycle counter for collection-403 soft-skips.
 * Scoped by AsyncLocalStorage so the count never bleeds across concurrent
 * per-user pg-boss jobs. Mirrors the WHOOP `softSkipStorage` tracker.
 */
interface SoftSkipTracker {
  count: number;
}
const softSkipStorage = new AsyncLocalStorage<SoftSkipTracker>();

/**
 * Per-cycle ledger of collection fetches that HARD-failed (non-403). A hard
 * failure on one collection must not abort its siblings — steps 400ing must
 * not suppress distance / floors / active-energy — so
 * `handleCollectionFetchError` records the failure here and returns instead of
 * rethrowing. The orchestrator reads the ledger to keep the cycle's verdict
 * honest: any entry ⇒ the run counts as failed (partial error), the watermark
 * is NOT stamped, and the next tick refetches the window.
 */
interface HardFailTracker {
  failures: string[];
}
const hardFailStorage = new AsyncLocalStorage<HardFailTracker>();

/**
 * Per-cycle accumulator of the `(type, day)` keys every resource's writes
 * touched. Only populated on a `fullSync` backfill (when the inline per-day
 * rollup hook is deferred); the orchestrator drains it into ONE
 * `recomputeUserRollups(from, to)` pass at the end of the cycle. Scoped by
 * AsyncLocalStorage so concurrent per-user jobs never cross-pollinate.
 */
interface RollupDeferTracker {
  keys: Array<{ type: MeasurementType; measuredAt: Date }>;
}
const rollupDeferStorage = new AsyncLocalStorage<RollupDeferTracker>();

/**
 * Single-source the per-resource collection-fetch error handling. A 403 on one
 * data class soft-skips it (warn + return 0) so sibling resources still sync; a
 * soft-skip increments the ambient tracker so `syncUserGoogleHealth` can refuse
 * to stamp success on an all-403 grant-revoke cycle that imported nothing.
 *
 * Anything else records a classified sync failure, warns with the per-type
 * detail, notes the collection on the ambient hard-fail ledger, and RETURNS —
 * it does not rethrow. Every call site sits in a per-collection catch, so
 * returning lets the sibling collections in the same resource keep fetching
 * (one 400 on steps must not kill distance / floors / active-energy), while
 * the ledger still fails the cycle so the watermark is not stamped past the
 * broken collection.
 */
export async function handleCollectionFetchError(
  resource: string,
  userId: string,
  err: unknown,
): Promise<number> {
  if (isCollectionForbidden(err)) {
    getEvent()?.addWarning(
      `google-health ${resource} sync skipped for ${userId}: collection 403 (soft-skip)`,
    );
    const tracker = softSkipStorage.getStore();
    if (tracker) tracker.count += 1;
    return 0;
  }
  await recordGoogleHealthSyncFailure(userId, err);
  getEvent()?.addWarning(
    `google-health ${resource} failed for ${userId}: ${err}`,
  );
  const hardTracker = hardFailStorage.getStore();
  if (hardTracker) hardTracker.failures.push(resource);
  return 0;
}

/**
 * Options threaded from `syncUserGoogleHealth` to each per-resource sync. The
 * `start` watermark is snapshotted ONCE by the orchestrator (a single
 * `lastSyncedAt` read) so every resource fetches from the same lower bound; no
 * resource re-reads `lastSyncedAt` or stamps `markSynced` itself. On a
 * full/backfill run `start` is undefined (no lower bound). The orchestrator owns
 * the single end-of-cycle `markSynced`.
 */
export interface GoogleHealthResourceSyncOptions {
  fullSync?: boolean;
  /** The incremental lower bound, snapshotted once by the orchestrator. */
  start?: Date;
  /**
   * When true, `upsertGoogleHealthMeasurements` writes the rows but SKIPS the
   * inline per-(type,day) DAY-rollup recompute + status-insight invalidate,
   * returning the touched type-days to the caller instead. The orchestrator
   * collapses them into ONE `recomputeUserRollups(from, to)` pass at the end of
   * a `fullSync` cycle, so a multi-year backfill pays a single range-recompute
   * rather than thousands of per-day round-trips. The incremental path leaves
   * this unset and keeps the inline per-day hook.
   */
  deferRollup?: boolean;
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
  const overlap = opts.overlapMs ?? GOOGLE_HEALTH_DEFAULT_OVERLAP_MS;
  if (lastSyncedAt) return new Date(lastSyncedAt.getTime() - overlap);
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

/**
 * One mapped reading destined for a `Measurement` row, with the per-point anchor
 * already resolved into a full `externalId`. The per-resource syncs build these
 * from the client mappers (`<anchor>:<fieldTag>`).
 */
export interface GoogleHealthMeasurementUpsert {
  type: string;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  /**
   * Per-stage sleep rows carry the `SleepStage` axis so the (up to six) stage
   * rows for one night stay distinct under the dedup key; every other row omits
   * it (null). Sleep is the only producer.
   */
  sleepStage?: "IN_BED" | "AWAKE" | "ASLEEP" | "REM" | "CORE" | "DEEP" | null;
}

/** Chunk size for the batched `createMany` insert of fresh readings. */
const GOOGLE_HEALTH_CREATE_CHUNK = 500;

/** One just-fetched sleep session's window + the ids that must survive it. */
export interface GoogleHealthSleepReplaceWindow {
  /** Earliest segment start (UTC). Null → nothing to clean for this session. */
  windowStart: Date | null;
  /** Latest segment end (UTC). */
  windowEnd: Date | null;
  /** The fresh externalIds for THIS session — never soft-deleted. */
  keepIds: string[];
}

/**
 * Replace-by-window cleanup for re-scored Google sleep sessions.
 *
 * Google re-scores a night after the fact. Before the stable-anchor fix a
 * re-fetch minted fresh externalIds and left the prior night's rows LIVE, so the
 * night-total silently double-counted (a 7h35 night read as 10h+). For each
 * just-fetched session this soft-deletes any LIVE `GOOGLE_HEALTH`
 * `SLEEP_DURATION` row whose `measuredAt` falls inside the session's
 * `[windowStart, windowEnd]` but was NOT re-produced by this fetch (`keepIds`
 * are this session's fresh externalIds). Sleep sessions do not overlap in time,
 * so a scan bounded to one session's window only ever touches that session's own
 * rows — a fresh row is protected by `keepIds`, and any leftover (old volatile
 * key, or a segment Google dropped) is cleared. Rows OUTSIDE every returned
 * window are never touched, so a night Google did not re-report this tick stays
 * intact — no data loss, only stale duplicates and re-score orphans go. This is
 * also the repair path: a full backfill re-fetches history and cleans each night
 * as it goes. Best-effort — a cleanup failure never fails the user's sync.
 */
export async function replaceStaleGoogleHealthSleep(
  userId: string,
  sessions: GoogleHealthSleepReplaceWindow[],
): Promise<number> {
  let removed = 0;
  for (const s of sessions) {
    if (!s.windowStart || !s.windowEnd || s.keepIds.length === 0) continue;
    try {
      const res = await prisma.measurement.updateMany({
        where: {
          userId,
          source: "GOOGLE_HEALTH",
          type: "SLEEP_DURATION",
          deletedAt: null,
          measuredAt: { gte: s.windowStart, lte: s.windowEnd },
          externalId: { notIn: s.keepIds },
        },
        data: { deletedAt: new Date() },
      });
      removed += res.count;
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: sleep replace-by-window failed: ${err}`,
      );
    }
  }
  return removed;
}

/**
 * Write a batch of mapped Google Health readings for one user and (unless
 * deferred) fold the rollup tier + invalidate status-insight caches once at the
 * end (mirrors the WHOOP / Withings sync tail). Returns the count of rows
 * written plus the distinct `(type, day)` keys the write touched.
 *
 * TOMBSTONE-SAFE: the live-row probe filters `deletedAt: null`, so a row the
 * user soft-deleted (iOS LWW reconciler) is NOT matched — a fresh insert is
 * created instead of resurrecting the tombstone on the next hourly sync. The
 * partial unique index keeps the fresh insert from colliding with the live set.
 *
 * OVERWRITE CONTRACT preserved: a re-fetched daily summary (`stats:`-keyed and
 * every other stable per-point anchor) maps to the SAME live `externalId`, so
 * the probe finds the existing live row and takes the in-place update branch.
 *
 * BATCHING: the existence probe is a single `findMany` over the batch's
 * externalIds; fresh rows go through chunked `createMany`, and only the
 * already-live rows take a per-row `update` for their differing values.
 *
 * Best-effort on the rollup fold + insight invalidate — a populator hiccup never
 * fails the user's sync.
 */
export async function upsertGoogleHealthMeasurements(
  userId: string,
  readings: GoogleHealthMeasurementUpsert[],
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
        source: "GOOGLE_HEALTH",
        deletedAt: null,
        externalId: { in: externalIds },
      },
      select: { id: true, type: true, externalId: true },
    });
    liveByKey = new Map(
      existing
        .filter((e) => e.externalId !== null)
        .map((e) => [`${e.type} ${e.externalId}`, { id: e.id }]),
    );
  } catch (err) {
    // A probe failure must not strand the whole batch; fall back to treating
    // every row as fresh (the partial unique index still rejects a genuine
    // live-row collision, which the per-create catch swallows).
    getEvent()?.addWarning(`google-health: live-row probe failed: ${err}`);
  }

  const toCreate: Array<{
    type: MeasurementType;
    value: number;
    unit: string;
    measuredAt: Date;
    externalId: string;
    sleepStage: GoogleHealthMeasurementUpsert["sleepStage"];
  }> = [];
  const toUpdate: Array<{ id: string; r: GoogleHealthMeasurementUpsert }> = [];
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  // A batch can carry the same (type, externalId) twice (an overlap re-fetch);
  // collapse to last-write-wins so we never emit two creates for one live key.
  const plannedCreateKeys = new Set<string>();
  for (const r of readings) {
    const type = r.type as MeasurementType;
    const key = `${type} ${r.externalId}`;
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
        (c) => `${c.type} ${c.externalId}` === key,
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
  for (let i = 0; i < toCreate.length; i += GOOGLE_HEALTH_CREATE_CHUNK) {
    const chunk = toCreate.slice(i, i + GOOGLE_HEALTH_CREATE_CHUNK);
    try {
      const res = await prisma.measurement.createMany({
        data: chunk.map((c) => ({
          userId,
          type: c.type,
          source: "GOOGLE_HEALTH" as const,
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
      getEvent()?.addWarning(
        `google-health: failed to create measurements: ${err}`,
      );
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
      getEvent()?.addWarning(
        `google-health: failed to update measurement: ${err}`,
      );
    }
  }

  // On a `fullSync` backfill the caller defers the rollup fold: it collapses
  // every resource's touched type-days into a SINGLE range-recompute at the end
  // of the cycle. The incremental path keeps the inline per-day hook here.
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
        `google-health: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `google-health: rollup recompute failed for ${userId}: ${err}`,
    );
  }

  return { imported, touched };
}

/**
 * Stamp `lastSyncedAt = now`. Called ONCE per cycle by `syncUserGoogleHealth`
 * after a non-degenerate run — never per resource, so the watermark can't move
 * mid-cycle and shrink a later resource's fetch window.
 */
export async function markSynced(userId: string): Promise<void> {
  await prisma.googleHealthConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  });
}

/**
 * Full per-user sync across every Google Health resource. Drives the hourly
 * poll catch-all, the manual `/api/google-health/sync` trigger, and the
 * boot-time backfill (`fullSync: true`). Poll-only — there is no Google Health
 * webhook at launch (the Pub/Sub-style webhook uses a Tink keyset rotating every
 * 30 days, deferred), so there is no per-resource webhook enqueue path.
 *
 * Parks immediately when the connection is at `error_reauth` (the user must
 * reconnect first) — returns 0, matching the WHOOP / Withings no-op contract.
 *
 * Resources: health-metrics, daily-cumulative activity, per-stage sleep, and
 * exercise workouts. Each runs independently so a per-resource 403 (a Restricted
 * bundle the user did not grant) soft-skips only that resource.
 *
 * WATERMARK: the incremental `start` is snapshotted ONCE here and threaded to
 * every resource, and `markSynced` is stamped ONCE at the end. A per-resource
 * read+stamp would let the first resource move `lastSyncedAt` to now() so later
 * resources only see the last overlap window — silently dropping the gap after
 * an outage longer than the overlap.
 */
export async function syncUserGoogleHealth(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  if (await isReauthRequired(userId, GOOGLE_HEALTH_INTEGRATION_KEY)) {
    getEvent()?.addWarning(
      `google-health sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  // Snapshot the incremental watermark ONCE for the whole cycle. Every resource
  // sees the same `start`; no resource re-reads `lastSyncedAt` mid-cycle. On a
  // full/backfill run `incrementalStart` ignores the snapshot and returns
  // undefined (no lower bound).
  const connection = await prisma.googleHealthConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) return 0;
  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
  });
  const resourceOpts: GoogleHealthResourceSyncOptions = {
    fullSync: opts.fullSync,
    start,
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

  // Explicit labels — the production bundle minifies `fn.name` into a useless
  // single letter ("google-health c failed"), so the warning names the resource
  // itself.
  const resources = [
    { name: "metrics", fn: syncUserMetrics },
    { name: "activity", fn: syncUserActivity },
    { name: "sleep", fn: syncUserSleep },
    { name: "workout", fn: syncUserWorkout },
  ];

  const tracker: SoftSkipTracker = { count: 0 };
  const hardFailTracker: HardFailTracker = { failures: [] };
  const deferTracker: RollupDeferTracker = { keys: [] };
  let total = 0;
  let anyFailed = false;
  await softSkipStorage.run(tracker, async () => {
    await hardFailStorage.run(hardFailTracker, async () => {
      await rollupDeferStorage.run(deferTracker, async () => {
        for (const { name, fn } of resources) {
          try {
            total += await fn(userId, resourceOpts);
          } catch (err) {
            anyFailed = true;
            getEvent()?.addWarning(
              `google-health ${name} sync failed for ${userId}: ${err}`,
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
  // touched days. Best-effort: a populator hiccup never fails the backfill.
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
          `google-health: status-insight invalidate failed for ${userId}: ${err}`,
        );
      });
    } catch (err) {
      getEvent()?.addWarning(
        `google-health: backfill rollup recompute failed for ${userId}: ${err}`,
      );
    }
  }

  // A genuine grant-revoke 403s EVERY collection: each resource soft-skips
  // (returns 0, records no failure), so `anyFailed` stays false and `total` is
  // 0 — yet the connection is dead until the token-refresh path next catches the
  // 401. Don't stamp success when the whole cycle was soft-skipped and nothing
  // imported; leave the status as-is so the "looks-healthy" window closes.
  const allSoftSkipped = tracker.count >= resources.length && total === 0;

  if (!anyFailed && !allSoftSkipped) {
    // Stamp the watermark ONCE for the whole cycle, only on a non-degenerate
    // run. Every resource already saw the snapshot `start`, so stamping now()
    // here can't shrink a later resource's window.
    await markSynced(userId);
    await recordSyncSuccess(userId, GOOGLE_HEALTH_INTEGRATION_KEY);
  }

  annotate({
    action: { name: "googleHealth.sync", details: { imported: total } },
  });
  return total;
}

/**
 * Map a Google Health response classification onto a `FailureKind` and record
 * it. Shared by the token-refresh path and every per-resource catch block.
 */
export async function recordGoogleHealthSyncFailure(
  userId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await recordSyncFailure({
    userId,
    integration: GOOGLE_HEALTH_INTEGRATION_KEY,
    kind: classificationToFailureKind(classifyGoogleHealthError(err)),
    message,
    errorCode:
      err instanceof GoogleHealthApiError
        ? err.httpStatus?.toString()
        : undefined,
  });
}

export function classificationToFailureKind(
  classification: GoogleHealthClassification,
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
 * Bounded fan-out width for the hourly Google Health cohort poll. The cron tick
 * carries no `userId`, so the worker resolves every connection and hands the
 * cohort here. A small pool (rather than a strict serial loop) means one slow
 * Google response can't stall the whole cohort, while the cap keeps the burst of
 * per-user resource fetches + rollup writes from crowding the worker's DB pool.
 */
export const GOOGLE_HEALTH_POLL_CONCURRENCY = 4;

/**
 * Run a Google Health hourly-poll cohort with bounded concurrency + per-user
 * error isolation. Each user's `syncUserGoogleHealth` runs inside the pool; a
 * single user's failure (or a slow Google response) is captured through
 * `onUserError` and never aborts the rest of the pass. Returns the per-cohort
 * totals for the wide-event envelope.
 */
export async function runGoogleHealthPollCohort(
  userIds: string[],
  opts: {
    concurrency?: number;
    sync?: (userId: string) => Promise<number>;
    onUserError?: (userId: string, err: unknown) => void;
    /** Invoked after a user's sync lands `imported` measurements, so the worker
     *  can fire the eventful Vorsorge satisfaction enqueue without the
     *  google-health lib reaching into the job layer. */
    onUserSynced?: (userId: string, imported: number) => void;
  } = {},
): Promise<{ usersSynced: number; measurementsImported: number }> {
  const sync = opts.sync ?? ((userId: string) => syncUserGoogleHealth(userId));
  const limit = pLimit(opts.concurrency ?? GOOGLE_HEALTH_POLL_CONCURRENCY);

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
