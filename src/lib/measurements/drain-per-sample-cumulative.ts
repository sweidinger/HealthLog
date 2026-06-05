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
      let removed = 0;
      await pc.$transaction(async (tx) => {
        // Fold late per-sample rows INTO an existing collapsed daily
        // total rather than overwriting it. `bucketRowsByDay` strips
        // already-collapsed `stats:` rows from the bucket, so when a day
        // was collapsed on an earlier run and fresh per-sample rows
        // arrive late (a trailing watch sync after the day's total was
        // already minted), this bucket holds ONLY those late samples.
        // A blind `update: { value: reducedValue }` would replace the
        // full day total with just the partial late sum — and the
        // original contributing samples were already hard-deleted, so
        // the lost count is unrecoverable.
        //
        // The probe runs inside the same transaction as the upsert +
        // delete so the read-modify-write of the total is atomic against
        // a concurrent drain. The late samples are genuine additional
        // readings (unlike the legacy-step pass, where the existing
        // total is HealthKit's own aggregate and the legacy rows would
        // double-count — so that sibling deliberately does NOT fold),
        // therefore the correct merge is `existing + late sum`. The
        // per-sample rows are hard-deleted either way so a re-run cannot
        // re-accumulate them.
        const existing = await tx.measurement.findUnique({
          where: {
            userId_type_source_externalId: {
              userId,
              type,
              source: "APPLE_HEALTH",
              externalId,
            },
          },
          select: { value: true },
        });
        const mergedValue =
          existing !== null ? existing.value + reducedValue : reducedValue;

        // Upsert the daily-aggregated row first, then drop the
        // per-sample rows. The unique index
        // (userId, type, source, externalId) makes the upsert
        // idempotent across re-runs.
        await tx.measurement.upsert({
          where: {
            userId_type_source_externalId: {
              userId,
              type,
              source: "APPLE_HEALTH",
              externalId,
            },
          },
          create: {
            userId,
            type,
            value: reducedValue,
            // pick the canonical unit from an existing row; the
            // per-sample rows all carry the same unit on a given type.
            // dayRows always has ≥1 row (empty buckets are skipped).
            unit:
              dayRows[0]?.value !== undefined
                ? await resolveCanonicalUnit(tx, userId, type)
                : "count",
            source: "APPLE_HEALTH",
            measuredAt: canonicalTimestamp,
            externalId,
          },
          update: {
            value: mergedValue,
            measuredAt: canonicalTimestamp,
          },
        });

        // Delete the per-sample rows that contributed to the sum.
        // Using `id IN (...)` is bounded by the per-bucket cap (the
        // largest cumulative bucket in real data is a ~1 440-row
        // stepCount day on a phone-only user).
        const del = await tx.measurement.deleteMany({
          where: { id: { in: sourceRowIds } },
        });
        removed = del.count;
      });
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
        outcome?.kind === "written" ? outcome.sourceRowsRemoved : dayRows.length;
      summary.totals.dailyRowsUpserted += 1;
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
    `[drain] done — usersScanned=${summary.totals.usersScanned} bucketsCollapsed=${summary.totals.bucketsCollapsed} perSampleRowsDeleted=${summary.totals.perSampleRowsDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted}${options.dryRun ? " (dry-run)" : ""}`,
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
