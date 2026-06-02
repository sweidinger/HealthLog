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
      let removed = 0;
      await pc.$transaction(async (tx) => {
        // Mint / refresh the canonical daily-mean row first. The unique
        // index (userId, type, source, externalId) makes the upsert
        // idempotent across re-runs. Built field-by-field (no spread) per
        // the no-mass-assignment convention.
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
            unit,
            source: "APPLE_HEALTH",
            measuredAt: canonicalTimestamp,
            externalId,
          },
          update: {
            value: reducedValue,
            measuredAt: canonicalTimestamp,
            deletedAt: null,
          },
        });

        // Soft-delete the out-of-window per-sample rows in the same
        // transaction — tombstone, never hard-delete; they remain as an
        // audit trail and drop off the live read + this pass's re-run
        // discovery.
        const del = await tx.measurement.updateMany({
          where: { id: { in: sourceRowIds }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        removed = del.count;
      });

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
