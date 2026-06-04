/**
 * v1.10.0 — dense intra-day retention tier for daytime HRV / heart-rate.
 *
 * The Stress engine (`src/lib/insights/stress-score.ts`) reads the
 * intra-day SDNN SHAPE across the day — the spread of a day's
 * `HEART_RATE_VARIABILITY` (and daytime `PULSE`) samples, not a single
 * daily mean. Apple Health ships those as discrete per-sample rows, so the
 * raw samples must survive long enough for the engine to read them.
 *
 * Two facts make a bounded raw-retention window the right shape rather than
 * a new storage paradigm:
 *
 *   1. `HEART_RATE_VARIABILITY` and `PULSE` are NOT in the destructive
 *      daily-mean drain's allowlist (`HIGH_FREQUENCY_MEAN_TYPES` in
 *      `apple-health-mapping.ts`). The nightly `mean-consolidation` never
 *      collapses them, so the intra-day shape is preserved by construction
 *      — the drain-exemption the Stress engine relies on. (PULSE was
 *      already excluded for the correlation/scatter readers; HRV is
 *      exempted here for the same reason the Stress proxy needs it.) A
 *      regression test pins both exclusions.
 *
 *   2. A BOUNDED retention window contains the volume the exemption would
 *      otherwise let grow forever. This pass REUSES the proven
 *      mean-consolidation drain (same `runConsolidation` base, same
 *      idempotent `stats:<HK>:<day>` fold, same soft-delete + rollup
 *      recompute) but with the grace cutoff widened from 36 hours to the
 *      retention window: per-sample HRV / HR rows OLDER than the window are
 *      folded to one daily-mean row and the raw rows are tombstoned; rows
 *      INSIDE the window stay raw so the Stress engine always has its
 *      intra-day inputs for the days it scores.
 *
 * The net effect: the last `DENSE_INTRADAY_RETENTION_DAYS` carry the dense
 * intra-day samples; everything older folds to the same daily-mean grain
 * the rest of the high-frequency metrics already use, and the
 * `MeasurementRollup` DAY/WEEK/MONTH/YEAR tiers keep serving the long
 * history. No new table, no new value column — the retention bound lives
 * here in code so tuning it never needs a migration.
 *
 * Runs on pg-boss (`DENSE_INTRADAY_RETENTION_QUEUE`), modelled on the
 * `mean-consolidation` boot-time converging-backfill pattern — the
 * production standalone image strips `tsx`, so this can never be a CLI.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { isP2002 as isUniqueConstraintViolation } from "@/lib/prisma-errors";

import {
  dailyStatsExternalId,
  hkIdentifierForType,
} from "./apple-health-mapping";
import {
  runConsolidation,
  type DayWriteOutcome,
} from "./consolidation-base";
import { meanBucketValue } from "./consolidate-daily-mean";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

/**
 * The dense-tier types. These are the daytime intra-day signals the Stress
 * engine reads as a shape. Both are deliberately EXEMPT from the
 * destructive daily-mean drain (`HIGH_FREQUENCY_MEAN_TYPES`); the
 * disjointness from that set is the load-bearing invariant a regression
 * test pins.
 */
export const DENSE_INTRADAY_RETENTION_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>(["HEART_RATE_VARIABILITY", "PULSE"]);

/**
 * Retention bound (days). Per-sample HRV / HR rows older than this window
 * fold to one daily-mean row and the raw rows tombstone; rows inside the
 * window stay raw so the Stress engine has its intra-day inputs.
 *
 * 14 days covers the Stress engine's 7-day reference window plus a margin
 * for late watch syncs and a backfilled gap, while keeping the raw
 * per-sample volume bounded to roughly two weeks of samples per dense type.
 */
export const DENSE_INTRADAY_RETENTION_DAYS = 14;

/** The daily-stats externalId prefix marks an already-collapsed row. */
const DAILY_STATS_PREFIX = "stats:";


export interface DenseIntradayRetentionSummary {
  dryRun: boolean;
  totals: {
    usersScanned: number;
    daysConsolidated: number;
    perSampleRowsSoftDeleted: number;
    dailyRowsUpserted: number;
  };
}

export interface DenseIntradayRetentionOptions {
  /** Limit the pass to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
  /**
   * Retention window in days. Per-sample rows OLDER than `now() -
   * retentionDays` are folded; rows inside the window stay raw. Defaults to
   * `DENSE_INTRADAY_RETENTION_DAYS`. An explicit one-shot can pass `0` to
   * fold everything (no protection window) — used only by tests / a manual
   * full-collapse, never by the scheduled pass.
   */
  retentionDays?: number;
}

/**
 * Run the dense intra-day retention drain. Folds per-sample HRV / HR rows
 * older than the retention window into one daily-mean `stats:` row per user
 * × type × day and soft-deletes the raw rows; rows inside the window stay
 * raw. Idempotent — re-invocation after a successful pass converges to zero
 * work because the folded rows are soft-deleted and so excluded from the
 * live scan, and the minted stats row is excluded by the `NOT
 * startsWith('stats:')` predicate.
 *
 * Does NOT enforce any auth gate — the queue handler owns that concern.
 */
export async function runDenseIntradayRetention(
  prismaClient: PrismaClient,
  options: DenseIntradayRetentionOptions = {},
): Promise<DenseIntradayRetentionSummary> {
  const log = options.log ?? ((line) => console.log(line));
  const retentionDays = options.retentionDays ?? DENSE_INTRADAY_RETENTION_DAYS;
  // The shared base resolves the cutoff from `cutoffHours`; the retention
  // window is the same mechanism expressed in days, so the rows newer than
  // it stay raw exactly like the mean-consolidation grace window keeps
  // today's syncs raw — only the width differs.
  const cutoffHours = retentionDays > 0 ? retentionDays * 24 : undefined;

  const summary: DenseIntradayRetentionSummary = {
    dryRun: options.dryRun ?? false,
    totals: {
      usersScanned: 0,
      daysConsolidated: 0,
      perSampleRowsSoftDeleted: 0,
      dailyRowsUpserted: 0,
    },
  };

  const { usersScanned } = await runConsolidation<MeasurementType>({
    prismaClient,
    options: { ...options, cutoffHours },
    types: DENSE_INTRADAY_RETENTION_TYPES,
    hkIdentifierForType,
    dailyStatsExternalId,
    statsPrefix: DAILY_STATS_PREFIX,
    // Mean is the correct out-of-window reduction — the same reducer the
    // daily-mean consolidation uses for the other high-frequency spot
    // metrics. Reused verbatim so the two surfaces can never drift.
    reduce: meanBucketValue,
    // Live per-sample rows for the type, source-scoped to APPLE_HEALTH so
    // manual + Withings spot rows survive. The single minted stats row is
    // excluded by the NOT-startsWith predicate so it is never re-folded;
    // soft-deleted rows are excluded so a re-run converges. `cutoffAt` is
    // the retention boundary — rows newer than it (inside the window) are
    // NOT scanned, so the dense intra-day shape is preserved.
    buildScanWhere: ({ userId, type, cutoffAt, statsPrefix }) => ({
      userId,
      source: "APPLE_HEALTH",
      type,
      deletedAt: null,
      NOT: { externalId: { startsWith: statsPrefix } },
      ...(cutoffAt ? { measuredAt: { lt: cutoffAt } } : {}),
    }),
    scanSelect: {
      id: true,
      type: true,
      value: true,
      measuredAt: true,
      externalId: true,
      unit: true,
    },
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
      const unit = dayRows[0]?.unit ?? "unknown";

      // Fold the day to one canonical daily-mean row at local-noon.
      //
      // Unlike `consolidate-daily-mean` (whose types never share the
      // canonical local-noon instant with another path), the dense-tier
      // types HRV / PULSE are dense enough that a per-sample row can land
      // exactly on the canonical timestamp, and a previously-minted daily
      // row can already occupy it. TWO unique indexes can collide:
      //   A) `(userId, type, source, externalId)` — the row already
      //      carrying the target `stats:` externalId.
      //   B) `(userId, type, measuredAt, source, sleepStage)` (NULLS NOT
      //      DISTINCT) — any row sitting on the canonical local-noon
      //      instant, which may carry a DIFFERENT externalId (a sibling
      //      consolidation path, a manual daily entry, or a per-sample row
      //      that happened at local noon).
      //
      // Determinism (VECTOR 1): resolve the canonical row by index A FIRST —
      // the row that already holds the target `stats:` externalId IS the
      // canonical daily row by construction. Only when no such row exists do
      // we fall back to the index-B row physically occupying the canonical
      // instant. A stable `orderBy: id` pins the pick. Adopting the wrong
      // sibling and stamping the target externalId onto it would otherwise
      // collide with the real `stats:` row on index A.
      //
      // Concurrency (VECTOR 2): the resolve→create is a check-then-act not
      // serialised by the unique index under READ COMMITTED. If a concurrent
      // writer wins the canonical slot between the lookup and the INSERT, the
      // `create` throws P2002 and Postgres aborts the whole transaction. We
      // therefore catch P2002 OUTSIDE the transaction (a caught error inside
      // would leave the tx in the aborted `25P02` state) and retry the fold
      // once: on the retry the deterministic lookup finds the now-existing
      // row and ADOPTS it, so the create path never fires twice. Mirrors the
      // `consolidate-legacy-steps.ts` P2002 classification, but recovers in
      // place rather than skipping, because the colliding row IS the
      // canonical daily row this fold owns. Built field-by-field (no spread)
      // per the no-mass-assignment convention.
      const foldOnce = async (): Promise<number> => {
        let removed = 0;
        await pc.$transaction(async (tx) => {
          // Index-A row: already carries the target `stats:` externalId. By
          // construction this drain only ever mints `stats:` rows at the
          // canonical instant, so in the common case this row IS the
          // canonical daily row already sitting at local-noon.
          const eidRow = await tx.measurement.findFirst({
            where: { userId, type, source: "APPLE_HEALTH", externalId },
            select: { id: true, measuredAt: true },
            orderBy: { id: "asc" },
          });
          // Index-B row: occupies the canonical local-noon instant
          // (`sleepStage` is NULL for these continuous types, matched via the
          // NULLS-NOT-DISTINCT index). At most one such row can exist.
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

          let canonicalRowId: string;
          if (adoptTarget) {
            // Pin the adopted row to local-noon, but only when the canonical
            // slot is free or already this row — a DIFFERENT row occupying
            // the slot (a per-sample row that fell on local-noon, now being
            // folded) would otherwise collide on index B. In that rare case
            // (only reachable on a tz/DST shift between mints) the row keeps
            // its existing instant; the `stats:` externalId is the identity,
            // measuredAt is secondary.
            const slotIsFreeForTarget =
              slotRow === null || slotRow.id === adoptTarget.id;
            // Adopt: refresh value, stamp the `stats:` externalId, optionally
            // re-anchor to local-noon, and un-tombstone. This coexists with a
            // pre-existing daily row instead of colliding with it.
            await tx.measurement.update({
              where: { id: adoptTarget.id },
              data: {
                value: reducedValue,
                unit,
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
                unit,
                source: "APPLE_HEALTH",
                measuredAt: canonicalTimestamp,
                externalId,
              },
              select: { id: true },
            });
            canonicalRowId = created.id;
          }

          // Soft-delete the out-of-window per-sample rows in the same
          // transaction — tombstone, never hard-delete; they remain as an
          // audit trail and drop off the live read + this pass's re-run
          // discovery. EXCLUDE the canonical row itself: a per-sample row
          // that happened to fall on the canonical local-noon instant is the
          // row we just adopted as the daily mean, so tombstoning it would
          // erase the fold.
          const del = await tx.measurement.updateMany({
            where: {
              id: { in: sourceRowIds, not: canonicalRowId },
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
          removed = del.count;
        });
        return removed;
      };

      let removed: number;
      try {
        removed = await foldOnce();
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) throw err;
        // A concurrent writer won the canonical slot mid-transaction. Retry
        // once: the deterministic lookup now resolves the winning row and
        // adopts it, so this pass cannot create a duplicate.
        removed = await foldOnce();
      }

      // Recompute the affected (user, type, day) rollup buckets after the
      // fold commits — the rollup tier reads only `deleted_at IS NULL`, so
      // the stale DAY bucket must re-aggregate against the single
      // consolidated row, exactly as the mean-consolidation drain does.
      await recomputeBucketsForMeasurement(userId, type, canonicalTimestamp);

      return { kind: "written", sourceRowsRemoved: removed };
    },
    recordBucket: ({ dayRows, outcome }) => {
      summary.totals.daysConsolidated += 1;
      summary.totals.dailyRowsUpserted += 1;
      summary.totals.perSampleRowsSoftDeleted +=
        outcome?.kind === "written" ? outcome.sourceRowsRemoved : dayRows.length;
    },
    onUserComplete: ({ userId, tz, dryRun }) => {
      log(
        `[dense-intraday-retention] user=${userId} tz=${tz}${dryRun ? " (dry-run)" : ""}`,
      );
    },
  });

  summary.totals.usersScanned = usersScanned;

  log(
    `[dense-intraday-retention] done — usersScanned=${summary.totals.usersScanned} daysConsolidated=${summary.totals.daysConsolidated} perSampleRowsSoftDeleted=${summary.totals.perSampleRowsSoftDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted}${options.dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}
