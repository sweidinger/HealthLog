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
import { runConsolidation, type DayWriteOutcome } from "./consolidation-base";
import { meanBucketValue } from "./consolidate-daily-mean";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { percentile } from "@/lib/insights/strain-score";
import type { PerSampleRow } from "./drain-per-sample-cumulative";

/**
 * iOS#34 / #69 — heart-rate (PULSE) is the densest spot signal after
 * walking-distance: ~16k raw rows per Apple-Health user. Collapsing a
 * folded PULSE day to a single MEAN row (the plain dense-tier fold) keeps
 * the chart mean + bounds the bloat, but it would erase the two
 * clinically-meaningful daily figures the rest of the app derives from the
 * raw stream:
 *
 *   1. **Resting HR.** `resolveRestingPulseSeries`
 *      (`src/lib/analytics/resting-pulse.ts`) prefers a native
 *      `RESTING_HEART_RATE` series and, for users who have none, falls back
 *      to the 20th-percentile-of-each-day's-raw-PULSE proxy (the day's
 *      floor, excluding the workout burst in the upper tail). Once the raw
 *      PULSE rows are folded that proxy can no longer be computed — a
 *      single mean row is `n = 1` and is skipped by the proxy's
 *      `RESTING_PROXY_MIN_DAILY_SAMPLES` floor. So for a proxy user the
 *      resting tile would silently lose every folded day.
 *   2. **Daily min / max.** The persistent `MeasurementRollup` DAY bucket
 *      stores `min_value` / `max_value` / `mean`, but it aggregates LIVE
 *      `deleted_at IS NULL` rows — recomputing it AFTER the fold collapses
 *      min == max == mean.
 *
 * The PULSE facet of this drain therefore preserves the full daily signal
 * WITHOUT polluting the PULSE read path (the rollup tier averages every
 * live PULSE row, so extra min/max rows of type PULSE would corrupt the
 * mean):
 *
 *   - Recompute the DAY rollup from the RAW rows BEFORE the fold, so the
 *     persistent tier keeps the true intraday min / max / mean, then SKIP
 *     the post-fold PULSE-DAY recompute that would collapse them.
 *   - Fold the raw PULSE day to one MEAN `stats:` PULSE row — the chart +
 *     rollup-mean read path is unchanged (AVG over one row == the mean).
 *   - For a PROXY user (zero native `RESTING_HEART_RATE` rows), mint one
 *     derived `RESTING_HEART_RATE` row per folded day from the day's
 *     20th-percentile floor, sourced `COMPUTED` so it never collides with
 *     Apple's own resting rows and reads back as the clean resting series
 *     the resolver prefers. Users WITH native resting rows already have the
 *     clean signal; minting alongside would double-count, so they are
 *     skipped.
 *
 * HRV keeps the plain mean-only fold — out-of-window HRV has no resting /
 * min / max consumer (the Stress engine reads the IN-window shape, which
 * this drain never folds).
 */

/**
 * The dense-tier types. These are the high-frequency intra-day signals that
 * accumulate raw per-sample rows the destructive daily-mean drain never
 * touches:
 *
 *   - `HEART_RATE_VARIABILITY` + `PULSE` — the daytime shape the Stress
 *     engine reads (v1.10.0 / v1.18.11).
 *   - `OXYGEN_SATURATION` — Apple Watch's Blood-Oxygen app samples SpO2
 *     periodically through the day and overnight; the readings map to
 *     `aggregation: "latest"` and sit in NEITHER `CUMULATIVE_HK_TYPES` nor
 *     `HIGH_FREQUENCY_MEAN_TYPES`, so every sample piled up raw forever.
 *     Folded here to one daily-mean row with the daily min/max preserved on
 *     the rollup tier (the lowest sample is the overnight-desaturation
 *     nadir — clinically the meaningful figure, not the mean).
 *
 * Every member is deliberately EXEMPT from the destructive daily-mean drain
 * (`HIGH_FREQUENCY_MEAN_TYPES`); the disjointness from that set is the
 * load-bearing invariant a regression test pins — a type in both would be
 * folded by two drains at once and corrupt the value.
 *
 * `RESPIRATORY_RATE` is deliberately NOT here: it is already a member of
 * `HIGH_FREQUENCY_MEAN_TYPES`, so the nightly mean-consolidation already
 * collapses it to a daily-mean row. Adding it here would double-fold it.
 */
export const DENSE_INTRADAY_RETENTION_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    "HEART_RATE_VARIABILITY",
    "PULSE",
    "OXYGEN_SATURATION",
  ]);

/**
 * Dense-tier types whose daily MIN / MAX are clinically meaningful and must
 * survive the fold. For these, the DAY rollup bucket is recomputed from the
 * RAW rows BEFORE the fold (while min/max are still computable from live
 * rows) and the post-fold recompute that would collapse min == max == mean is
 * SKIPPED — identical to the PULSE facet (iOS#34), generalised:
 *
 *   - `PULSE` — daily min/max bound the resting floor + workout peak.
 *   - `OXYGEN_SATURATION` — the daily MIN is the overnight-desaturation
 *     nadir, the single most clinically meaningful SpO2 figure; the mean
 *     alone would hide a transient nocturnal dip.
 *
 * `HEART_RATE_VARIABILITY` is absent: out-of-window HRV has no min/max
 * consumer (the Stress engine reads the IN-window shape this drain never
 * folds), so it keeps the simpler post-fold recompute against its mean row.
 */
const DENSE_MIN_MAX_PRESERVING_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>(["PULSE", "OXYGEN_SATURATION"]);

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

/**
 * The HealthKit identifier the derived resting row mints its `stats:`
 * externalId under. It is the SAME identifier `RESTING_HEART_RATE` maps to
 * in `apple-health-mapping.ts`, so the row reads back as a canonical daily
 * resting figure; the `COMPUTED` source keeps it distinct from Apple's own
 * `RESTING_HEART_RATE` rows on both unique indexes.
 */
const RESTING_HK_IDENTIFIER = "HKQuantityTypeIdentifierRestingHeartRate";

/**
 * Percentile of a day's raw PULSE samples used as that day's resting
 * estimate. Mirrors `RESTING_PROXY_DAILY_PERCENTILE` in
 * `src/lib/analytics/resting-pulse.ts` — the 20th percentile is the day's
 * low band (above the rare sleeping-bradycardia outlier, below the bulk of
 * waking + workout HR), so it tracks resting HR without being pulled up by a
 * dense workout burst. Kept in lockstep with the read-path proxy so the
 * resting figure a folded day persists equals the figure the proxy would
 * have produced from the now-deleted raw rows.
 */
const RESTING_DERIVE_PERCENTILE = 20;

/**
 * Minimum PULSE samples a day needs before it contributes a derived resting
 * row. Mirrors `RESTING_PROXY_MIN_DAILY_SAMPLES` — a one/two-sample day
 * cannot distinguish a resting floor from a lone workout reading, so it is
 * skipped rather than persisting a workout-level number as "resting".
 */
const RESTING_DERIVE_MIN_DAILY_SAMPLES = 3;

/**
 * Derive the resting estimate for a single folded PULSE day from its raw
 * samples — the rounded 20th percentile, or `null` when the day has too few
 * samples to tell a resting floor from a lone reading. Pure; exported for
 * unit testing without Prisma. Kept value-for-value in step with
 * `deriveRestingProxyFromPulse`.
 */
export function deriveDailyRestingFromPulse(
  rows: readonly PerSampleRow[],
): number | null {
  if (rows.length < RESTING_DERIVE_MIN_DAILY_SAMPLES) return null;
  return Math.round(
    percentile(
      rows.map((r) => r.value),
      RESTING_DERIVE_PERCENTILE,
    ),
  );
}

export interface DenseIntradayRetentionSummary {
  dryRun: boolean;
  totals: {
    usersScanned: number;
    daysConsolidated: number;
    perSampleRowsSoftDeleted: number;
    dailyRowsUpserted: number;
    /**
     * Derived `RESTING_HEART_RATE` rows minted from folded PULSE days for
     * proxy users (zero native resting rows). iOS#34 — preserves the
     * resting signal the raw-PULSE proxy can no longer compute after fold.
     */
    derivedRestingRowsUpserted: number;
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
      derivedRestingRowsUpserted: 0,
    },
  };

  // iOS#34 — per-user memo of whether the user has ANY native
  // `RESTING_HEART_RATE` row. The read-path resolver
  // (`resolveRestingPulseSeries`) is all-or-nothing: a single native
  // resting row makes it ignore the PULSE proxy entirely. So the derived
  // resting row is minted ONLY for proxy users (zero native rows) — minting
  // alongside native rows would double-count. Memoised so the per-day fold
  // does not re-query, and cleared per user at the start of the walk.
  const nativeRestingByUser = new Map<string, boolean>();
  async function userHasNativeResting(userId: string): Promise<boolean> {
    const cached = nativeRestingByUser.get(userId);
    if (cached !== undefined) return cached;
    const native = await prismaClient.measurement.findFirst({
      where: { userId, type: "RESTING_HEART_RATE", deletedAt: null },
      select: { id: true },
    });
    const has = native !== null;
    nativeRestingByUser.set(userId, has);
    return has;
  }

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
      const isPulse = type === "PULSE";
      const preservesMinMax = DENSE_MIN_MAX_PRESERVING_TYPES.has(type);

      // iOS#34 — min/max preservation (PULSE + SpO2). The persistent
      // `MeasurementRollup` DAY bucket stores min/max/mean but aggregates LIVE
      // rows; recomputing it AFTER the fold (one mean row) collapses
      // min == max == mean. So for the min/max-preserving types, recompute the
      // DAY bucket from the RAW rows BEFORE the fold, while they are still live
      // — the bucket then keeps the TRUE intraday min/max/mean (for SpO2 the
      // MIN is the overnight-desaturation nadir) — and the post-fold recompute
      // is SKIPPED below. HRV has no min/max consumer, so it keeps the simpler
      // post-fold recompute.
      if (preservesMinMax && !options.dryRun) {
        await recomputeBucketsForMeasurement(userId, type, canonicalTimestamp);
      }

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

      // iOS#34 — preserve the resting signal for PROXY users. For a user
      // with zero native `RESTING_HEART_RATE` rows, the read-path resolver
      // derives resting from the 20th-percentile of each day's RAW PULSE; the
      // fold has just deleted those rows, so that day's resting figure would
      // vanish. Mint one derived `RESTING_HEART_RATE` row from the same
      // percentile, sourced `COMPUTED` (distinct from Apple's own resting
      // rows on both unique indexes), so the day reads back as the clean
      // resting series the resolver prefers. Skipped for users WITH native
      // resting rows (the resolver ignores the proxy entirely for them, so a
      // derived row would only double-count).
      if (isPulse) {
        const restingValue = deriveDailyRestingFromPulse(dayRows);
        if (restingValue !== null && !(await userHasNativeResting(userId))) {
          const restingExternalId = dailyStatsExternalId(
            RESTING_HK_IDENTIFIER,
            // The fold's canonical timestamp is local-noon of the day; reuse
            // its UTC date for the resting row's `stats:` key so a re-run
            // upserts the same row instead of minting a sibling.
            canonicalTimestamp.toISOString().slice(0, 10),
          );
          await pc.measurement.upsert({
            where: {
              userId_type_source_externalId: {
                userId,
                type: "RESTING_HEART_RATE",
                source: "COMPUTED",
                externalId: restingExternalId,
              },
            },
            create: {
              userId,
              type: "RESTING_HEART_RATE",
              value: restingValue,
              unit: "bpm",
              source: "COMPUTED",
              measuredAt: canonicalTimestamp,
              externalId: restingExternalId,
            },
            update: { value: restingValue, deletedAt: null },
          });
          summary.totals.derivedRestingRowsUpserted += 1;
          // The derived row is its own (type, day); recompute its DAY bucket
          // so the rollup tier serves it on a covered read.
          await recomputeBucketsForMeasurement(
            userId,
            "RESTING_HEART_RATE",
            canonicalTimestamp,
          );
        }
      }

      // Recompute the affected (user, type, day) rollup buckets after the
      // fold commits — the rollup tier reads only `deleted_at IS NULL`, so
      // the stale DAY bucket must re-aggregate against the single
      // consolidated row, exactly as the mean-consolidation drain does.
      //
      // iOS#34 — for the min/max-preserving types (PULSE + SpO2) this would
      // COLLAPSE the true intraday min/max the pre-fold recompute above just
      // captured (the single folded row makes min == max == mean), so their
      // DAY bucket is left as the pre-fold recompute set it. HRV (no min/max
      // consumer) keeps the post-fold recompute against its single mean row.
      if (!preservesMinMax) {
        await recomputeBucketsForMeasurement(userId, type, canonicalTimestamp);
      }

      return { kind: "written", sourceRowsRemoved: removed };
    },
    recordBucket: ({ dayRows, outcome }) => {
      summary.totals.daysConsolidated += 1;
      summary.totals.dailyRowsUpserted += 1;
      summary.totals.perSampleRowsSoftDeleted +=
        outcome?.kind === "written"
          ? outcome.sourceRowsRemoved
          : dayRows.length;
    },
    onUserComplete: ({ userId, tz, dryRun }) => {
      log(
        `[dense-intraday-retention] user=${userId} tz=${tz}${dryRun ? " (dry-run)" : ""}`,
      );
    },
    // Per-day failure boundary (v1.18.10 lesson). A day whose fold throws —
    // e.g. a residual unique-index collision the adopt-in-place path could
    // not absorb, or a derived-resting upsert that races a native row — is
    // logged and STEPPED OVER so the global walk keeps draining every other
    // user / type / day. The failed day keeps its raw rows live (the fold
    // soft-deletes only on a committed transaction), so the next nightly run
    // retries it. Without this, one poisoned day aborted the whole walk and
    // stranded every later account.
    onBucketError: ({ userId, type, dateKey, error }) => {
      const reason = error instanceof Error ? error.message : String(error);
      log(
        `[dense-intraday-retention] user=${userId} type=${type} day=${dateKey} failed — ${reason}; continuing with the next bucket`,
      );
    },
  });

  summary.totals.usersScanned = usersScanned;

  log(
    `[dense-intraday-retention] done — usersScanned=${summary.totals.usersScanned} daysConsolidated=${summary.totals.daysConsolidated} perSampleRowsSoftDeleted=${summary.totals.perSampleRowsSoftDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted} derivedRestingRowsUpserted=${summary.totals.derivedRestingRowsUpserted}${options.dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}
