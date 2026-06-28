/**
 * v1.4.30 — drain pre-Option-A per-sample APPLE_HEALTH cumulative rows
 * into one row per day per type, keyed by the locked `dailyStatsExternalId`
 * shape. Idempotent: re-running collapses zero rows once every cumulative
 * bucket already holds a single `stats:...` row.
 *
 * Scope per `CUMULATIVE_HK_TYPES`:
 *   ACTIVITY_STEPS, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED,
 *   WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT
 *
 * Per user × type × calendar day (anchored to `User.timezone`):
 *   1. SELECT all `Measurement` rows with `source = 'APPLE_HEALTH'` and
 *      `type = <cumulative type>` and `measuredAt` within that user's
 *      calendar day boundary and `externalId NOT LIKE 'stats:%'`.
 *   2. If 0 rows → continue.
 *   3. If 1 row whose externalId already follows the `stats:...`
 *      shape → continue (already collapsed).
 *   4. SUM the values; pick canonical timestamp = midday UTC of the
 *      user's calendar day (matches the Withings activity-sync
 *      convention per R-A §5 / W17b).
 *   5. UPSERT a row with `externalId = dailyStatsExternalId(...)`,
 *      `value = sumValue`, `measuredAt = canonicalTimestamp`.
 *   6. DELETE the original per-sample rows in the same transaction.
 *
 * Designed to be invoked by both:
 *   - the CLI at `scripts/drain-per-sample-cumulative.ts`
 *   - the admin endpoint at
 *     `POST /api/admin/drain-per-sample-cumulative`
 *
 * The dry-run path emits the same per-user-day summary without
 * touching the DB so the operator can inspect what would change before
 * committing.
 */
import { Prisma } from "@/generated/prisma/client";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { isP2002 as isUniqueConstraintViolation } from "@/lib/prisma-errors";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

import {
  CUMULATIVE_HK_TYPES,
  dailyStatsExternalId,
  hkIdentifierForType,
} from "./apple-health-mapping";
import {
  bucketRowsByDay,
  runConsolidation,
  type DayWriteOutcome,
} from "./consolidation-base";
import {
  CONSOLIDATION_GRACE_CUTOFF_HOURS,
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  localDayWindow,
  localStartOfDay,
  type PerSampleRow,
} from "./consolidation-tz";

// Re-export the shared timezone day-math primitives + `PerSampleRow`
// shape so every established `drain-per-sample-cumulative` import site
// (the measurements route, the Apple-Health importer, the unit tests)
// keeps resolving them from here. The definitions moved to the
// dependency-free leaf `consolidation-tz.ts` to break the init-order
// cycle with `consolidation-base.ts`.
export {
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  localDayWindow,
  localStartOfDay,
};
export type { PerSampleRow };

/** Prefix marking an already-collapsed daily-stats row. */
const DAILY_STATS_PREFIX = "stats:";

/**
 * v1.4.38 — canonical cutoff for the nightly scheduled drain. Rows
 * whose `measuredAt` is newer than `now() - DRAIN_CUMULATIVE_CUTOFF_HOURS`
 * are excluded so today's still-in-flight Apple Watch syncs stay as
 * per-sample rows in the user's "today" view. 36 hours covers the
 * previous calendar day plus a generous trailing sync window for
 * watches that weren't worn at midnight. The CLI and the admin route
 * import the constant for visibility but deliberately pass `undefined`
 * by default so an explicit one-shot drain collapses every row the
 * operator points it at; pass the constant explicitly when mirroring
 * the nightly behaviour from an interactive shell. Sourced from the
 * shared `CONSOLIDATION_GRACE_CUTOFF_HOURS` so the cumulative + mean
 * drains track the same grace window.
 */
export const DRAIN_CUMULATIVE_CUTOFF_HOURS = CONSOLIDATION_GRACE_CUTOFF_HOURS;

/** Per-(user, type, day) action summary. */
export interface DrainBucket {
  userId: string;
  type: MeasurementType;
  /** Calendar-day key in the user's timezone (`YYYY-MM-DD`). */
  dateKey: string;
  /** Number of per-sample rows scanned for this bucket. */
  perSampleCount: number;
  /** SUM of per-sample values for this bucket (canonical-unit). */
  sumValue: number;
  /** ISO-8601 canonical timestamp (midday UTC of the user's calendar day). */
  canonicalTimestamp: string;
  /** Resulting `externalId` of the daily-aggregated row. */
  externalId: string;
}

export interface DrainSummary {
  /** Did the run actually write to the DB (false for `dryRun`). */
  dryRun: boolean;
  /** Per-user-day buckets the drain rewrote (or would rewrite). */
  buckets: DrainBucket[];
  /** Aggregate counts across the run. */
  totals: {
    usersScanned: number;
    bucketsCollapsed: number;
    perSampleRowsDeleted: number;
    dailyRowsUpserted: number;
    /**
     * Day buckets whose write threw a non-recoverable error and were stepped
     * over by the per-day boundary. A single poisoned day no longer aborts the
     * whole global walk — every other day still collapses.
     */
    daysFailed: number;
  };
}

export interface DrainOptions {
  /** Limit the drain to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes, no transaction commits. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * v1.4.37 W7c — protect recent per-sample rows from collapse so late
   * watch syncs still surface in real time before the list view shows
   * the day's total. When set, rows whose `measuredAt` is newer than
   * `now() - cutoffHours` are excluded from the scan; the drain only
   * acts on completed days that have had enough time to stabilise.
   *
   * The scheduled nightly call passes `36` so the previous day's
   * trailing sync window (Apple Watch reconciliations land up to a few
   * hours after midnight when the watch wasn't worn) is fully covered.
   * The CLI + admin endpoint default to `undefined` (drain everything
   * the operator points at) for explicit one-shot use.
   */
  cutoffHours?: number;
}

export interface BucketedRows {
  /** Map keyed by `YYYY-MM-DD` (user TZ). */
  byDay: Map<string, PerSampleRow[]>;
}

export function bucketRowsByUserDay(
  rows: readonly PerSampleRow[],
  tz: string,
): BucketedRows {
  // Skip rows already in the daily-stats shape — re-running the drain
  // on a previously-collapsed bucket is a no-op. Delegates to the shared
  // bucketing primitive; wrapped in `{ byDay }` for the established
  // return shape.
  return { byDay: bucketRowsByDay(rows, tz, DAILY_STATS_PREFIX) };
}

/**
 * Sum the values in a per-day bucket. Tiny helper; keeps the call
 * site (transactional drain loop) readable.
 */
export function sumBucketValues(rows: readonly PerSampleRow[]): number {
  let acc = 0;
  for (const row of rows) acc += row.value;
  return acc;
}

/**
 * Run the drain. Idempotent — re-invocation after a successful drain
 * reports zero buckets collapsed.
 *
 * The function does NOT enforce the admin gate or the operator-confirm
 * flag — the CLI wrapper + the admin endpoint own those concerns.
 */
export async function drainPerSampleCumulative(
  prismaClient: PrismaClient,
  options: DrainOptions = {},
): Promise<DrainSummary> {
  const log = options.log ?? ((line) => console.log(line));

  const summary: DrainSummary = {
    dryRun: options.dryRun ?? false,
    buckets: [],
    totals: {
      usersScanned: 0,
      bucketsCollapsed: 0,
      perSampleRowsDeleted: 0,
      dailyRowsUpserted: 0,
      daysFailed: 0,
    },
  };

  // v1.4.38 — per-user counters that mirror the aggregate totals so the
  // per-user COMPLETE log line carries useful numbers without re-walking
  // the summary list. Snapshotted in `onUserStart`, diffed in
  // `onUserComplete`.
  let beforeBucketsCollapsed = 0;
  let beforePerSampleDeleted = 0;
  let beforeDailyUpserted = 0;

  const { usersScanned } = await runConsolidation<MeasurementType>({
    prismaClient,
    options,
    types: CUMULATIVE_HK_TYPES,
    hkIdentifierForType,
    dailyStatsExternalId,
    statsPrefix: DAILY_STATS_PREFIX,
    reduce: sumBucketValues,
    // v1.4.37 W7c — exclude rows inside the grace window so the nightly
    // scheduled drain never collapses today's still-in-flight watch
    // syncs. No `deletedAt` filter and no NOT-stats predicate here: the
    // cumulative drain historically scans every row and relies on the
    // in-memory bucketer to skip already-collapsed `stats:` rows.
    buildScanWhere: ({ userId, type, cutoffAt }) => ({
      userId,
      source: "APPLE_HEALTH",
      type,
      ...(cutoffAt ? { measuredAt: { lt: cutoffAt } } : {}),
    }),
    writeDay: async ({
      prismaClient: pc,
      userId,
      type,
      externalId,
      canonicalTimestamp,
      reducedValue,
      dayRows,
      sourceRowIds,
    }): Promise<DayWriteOutcome> => {
      // Adopt-in-place canonical-noon resolution + a single P2002 retry,
      // mirroring `dense-intraday-retention.ts`. Two unique indexes can
      // collide when minting the daily-stats row:
      //   A) `(userId, type, source, externalId)` — a row already carrying
      //      the target `stats:` externalId (a prior collapse of this day).
      //   B) `(userId, type, measuredAt, source, sleepStage)` NULLS NOT
      //      DISTINCT — ANY row sitting on the canonical local-noon instant,
      //      which may carry a DIFFERENT externalId (a per-sample row that
      //      happened at local noon and is in this very bucket, or a manual
      //      daily row). A blind `create` against index B aborts the whole
      //      transaction, and — before the per-day error boundary below — the
      //      first colliding day aborted the ENTIRE global walk (3 s die-early,
      //      0 collapsed). Resolve the canonical row by index A first (it IS
      //      the daily row by construction), else the index-B slot row, and
      //      adopt it in place instead of colliding.
      const foldOnce = async (): Promise<number> => {
        let removed = 0;
        await pc.$transaction(async (tx) => {
          // Index-A row: already carries the target `stats:` externalId. When
          // present, this is the existing collapsed daily total.
          const eidRow = await tx.measurement.findFirst({
            where: { userId, type, source: "APPLE_HEALTH", externalId },
            select: { id: true, value: true },
            orderBy: { id: "asc" },
          });
          // Index-B row: occupies the canonical local-noon instant
          // (`sleepStage` is NULL for these cumulative types). At most one.
          const slotRow = await tx.measurement.findFirst({
            where: {
              userId,
              type,
              source: "APPLE_HEALTH",
              measuredAt: canonicalTimestamp,
              sleepStage: null,
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });

          // Prefer the externalId-carrying row (index A) — adopting a sibling
          // and stamping the target externalId onto it would collide with it.
          const adoptTarget = eidRow ?? slotRow;

          // Fold semantics. When the index-A `stats:` total already exists,
          // late per-sample rows are GENUINE additional readings, so the
          // correct merge is `existing + late sum` (a blind overwrite with the
          // partial late sum would shrink the day — the original samples are
          // already hard-deleted). When adopting a NON-stats slot row (a
          // per-sample row that fell on local noon, itself part of this
          // bucket), its value is already inside `reducedValue`, so the merged
          // value is just `reducedValue`. A fresh day mints `reducedValue`.
          const mergedValue =
            eidRow !== null ? eidRow.value + reducedValue : reducedValue;

          let canonicalRowId: string;
          if (adoptTarget) {
            // Pin the adopted row to local-noon only when the canonical slot
            // is free or already this row — a DIFFERENT row occupying the slot
            // would otherwise collide on index B. In that rare case (a tz/DST
            // shift between mints) the row keeps its existing instant; the
            // `stats:` externalId is the identity, measuredAt is secondary.
            const slotIsFreeForTarget =
              slotRow === null || slotRow.id === adoptTarget.id;
            await tx.measurement.update({
              where: { id: adoptTarget.id },
              data: {
                value: mergedValue,
                externalId,
                deletedAt: null,
                ...(slotIsFreeForTarget
                  ? { measuredAt: canonicalTimestamp }
                  : {}),
              },
            });
            canonicalRowId = adoptTarget.id;
          } else {
            const created = await tx.measurement.create({
              data: {
                userId,
                type,
                value: reducedValue,
                // pick the canonical unit from an existing row; the per-sample
                // rows all carry the same unit on a given type. dayRows always
                // has ≥1 row (empty buckets are skipped).
                unit:
                  dayRows[0]?.value !== undefined
                    ? await resolveCanonicalUnit(tx, userId, type)
                    : "count",
                source: "APPLE_HEALTH",
                measuredAt: canonicalTimestamp,
                externalId,
              },
              select: { id: true },
            });
            canonicalRowId = created.id;
          }

          // Hard-delete the per-sample rows that contributed to the sum.
          // EXCLUDE the adopted canonical row: a per-sample row that fell on
          // local-noon may be the row we just adopted as the daily total, so
          // deleting it would erase the fold. `id IN (...)` is bounded by the
          // per-bucket cap (largest real bucket is a ~1 440-row stepCount day).
          const del = await tx.measurement.deleteMany({
            where: { id: { in: sourceRowIds, not: canonicalRowId } },
          });
          removed = del.count;
        });
        return removed;
      };

      let removed: number;
      try {
        removed = await foldOnce();
      } catch (err) {
        // A concurrent writer won the canonical slot mid-transaction. Retry
        // once: the deterministic lookup now resolves the winning row and
        // adopts it, so this pass cannot create a duplicate. Non-P2002 errors
        // propagate to the per-day `onBucketError` boundary below.
        if (!isUniqueConstraintViolation(err)) throw err;
        removed = await foldOnce();
      }

      // Re-aggregate the affected (user, type, day) rollup bucket after the
      // fold commits — the per-sample rows are now gone and the canonical
      // daily-sum row is the only live reading. The rollup tier reads only
      // `deleted_at IS NULL`, so without this the day's DAY bucket keeps the
      // stale pre-drain (double-counted) sumValue forever and never
      // self-heals. Mirrors the mean drain's post-write recompute exactly.
      await recomputeBucketsForMeasurement(userId, type, canonicalTimestamp);

      return { kind: "written", sourceRowsRemoved: removed };
    },
    recordBucket: ({
      userId,
      type,
      dateKey,
      dayRows,
      reducedValue,
      canonicalTimestamp,
      externalId,
      outcome,
    }) => {
      summary.buckets.push({
        userId,
        type,
        dateKey,
        perSampleCount: dayRows.length,
        sumValue: reducedValue,
        canonicalTimestamp: canonicalTimestamp.toISOString(),
        externalId,
      });
      summary.totals.bucketsCollapsed += 1;
      // On a real run, count the rows the transaction actually removed;
      // on dry-run, count the rows that would have been removed.
      summary.totals.perSampleRowsDeleted +=
        outcome?.kind === "written"
          ? outcome.sourceRowsRemoved
          : dayRows.length;
      summary.totals.dailyRowsUpserted += 1;
    },
    // Per-day failure boundary. A day whose write throws (e.g. a residual
    // unique-index collision the adopt-in-place path could not absorb) is
    // logged and STEPPED OVER so the global walk keeps draining every other
    // user / type / day — the historical behaviour aborted the whole run on
    // the first poisoned day (3 s die-early, 0 collapsed).
    onBucketError: ({ userId, type, dateKey, error }) => {
      summary.totals.daysFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(
        `[drain] user=${userId} type=${type} day=${dateKey} skipped — write failed: ${message}`,
      );
    },
    onUserStart: ({ userId, tz, dryRun }) => {
      log(`[drain] user=${userId} tz=${tz}${dryRun ? " (dry-run)" : ""}`);
      beforeBucketsCollapsed = summary.totals.bucketsCollapsed;
      beforePerSampleDeleted = summary.totals.perSampleRowsDeleted;
      beforeDailyUpserted = summary.totals.dailyRowsUpserted;
    },
    onUserComplete: ({ userId, dryRun }) => {
      // v1.4.38 — per-user COMPLETE log line, mirrors the START line so
      // an operator scanning the worker log can pair start/finish for a
      // user without scrolling every per-type bucket.
      const userBucketsCollapsed =
        summary.totals.bucketsCollapsed - beforeBucketsCollapsed;
      const userPerSampleDeleted =
        summary.totals.perSampleRowsDeleted - beforePerSampleDeleted;
      const userDailyUpserted =
        summary.totals.dailyRowsUpserted - beforeDailyUpserted;
      log(
        `[drain] user=${userId} complete bucketsCollapsed=${userBucketsCollapsed} perSampleRowsDeleted=${userPerSampleDeleted} dailyRowsUpserted=${userDailyUpserted}${dryRun ? " (dry-run)" : ""}`,
      );
    },
  });

  summary.totals.usersScanned = usersScanned;

  log(
    `[drain] done — usersScanned=${summary.totals.usersScanned} bucketsCollapsed=${summary.totals.bucketsCollapsed} perSampleRowsDeleted=${summary.totals.perSampleRowsDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted} daysFailed=${summary.totals.daysFailed}${options.dryRun ? " (dry-run)" : ""}`,
  );
  return summary;
}

/**
 * Pull the canonical unit for a `(userId, type)` pair from an existing
 * per-sample row. Used during the upsert's `create` branch when we
 * need to populate `Measurement.unit` for the new aggregated row.
 */
async function resolveCanonicalUnit(
  tx: Prisma.TransactionClient,
  userId: string,
  type: MeasurementType,
): Promise<string> {
  const row = await tx.measurement.findFirst({
    where: { userId, type, source: "APPLE_HEALTH" },
    select: { unit: true },
  });
  return row?.unit ?? "count";
}
