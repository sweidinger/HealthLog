/**
 * v1.10.0 — dense intra-day retention tier for daytime HRV / heart-rate /
 * SpO2. v1.28.31 — the out-of-window fold target is HOURLY means (up to 24
 * `stats:` rows per day, user-local hours) instead of one daily mean, so
 * the intraday shape of a folded day survives at hour resolution.
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
 *      mean-consolidation drain skeleton (same `runConsolidation` base,
 *      same soft-delete + rollup handling) but with the grace cutoff
 *      widened from 36 hours to the retention window, and the fold grain
 *      set to the LOCAL HOUR: per-sample rows OLDER than the window fold
 *      to one `stats:<HK>:<YYYY-MM-DD>T<HH>` hourly-mean row per user ×
 *      type × local hour and the raw rows are tombstoned; rows INSIDE the
 *      window stay raw so the Stress engine always has its per-sample
 *      inputs for the days it scores.
 *
 * The net effect: the last `DENSE_INTRADAY_RETENTION_DAYS` carry the dense
 * per-sample stream; everything older folds to at most 24 hourly-mean rows
 * per day per type (~9k rows/year/type — bounded, vs the unbounded raw
 * stream), and the `MeasurementRollup` DAY/WEEK/MONTH/YEAR tiers keep
 * serving the long history. No new table, no new value column — the
 * retention bound and the fold grain live here in code so tuning either
 * never needs a migration.
 *
 * Runs on pg-boss (`DENSE_INTRADAY_RETENTION_QUEUE`), modelled on the
 * `mean-consolidation` boot-time converging-backfill pattern — the
 * production standalone image strips `tsx`, so this can never be a CLI.
 * The one-shot history rebuild that converts ALREADY-folded daily rows to
 * the hourly grain lives in `dense-intraday-hourly-rebuild.ts`.
 */
import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";
import { isP2002 as isUniqueConstraintViolation } from "@/lib/prisma-errors";

import {
  dailyStatsExternalId,
  hkIdentifierForType,
} from "./apple-health-mapping";
import { runConsolidation, type DayWriteOutcome } from "./consolidation-base";
import {
  canonicalHourlyTimestamp,
  hourOfDayForUserTz,
} from "./consolidation-tz";
import { meanBucketValue } from "./consolidate-daily-mean";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
import { percentile } from "@/lib/insights/strain-score";
import type { PerSampleRow } from "./drain-per-sample-cumulative";

/**
 * iOS#34 / #69 — heart-rate (PULSE) is the densest spot signal after
 * walking-distance: ~16k raw rows per Apple-Health user. The hourly fold
 * bounds that bloat while keeping the intraday shape at hour resolution,
 * but two clinically-meaningful daily figures still need explicit
 * preservation because they derive from the RAW stream:
 *
 *   1. **Resting HR.** `resolveRestingPulseSeries`
 *      (`src/lib/analytics/resting-pulse.ts`) prefers a native
 *      `RESTING_HEART_RATE` series and, for users who have none, falls back
 *      to the 20th-percentile-of-each-day's-raw-PULSE proxy (the day's
 *      floor, excluding the workout burst in the upper tail). Hourly means
 *      flatten the tails, so for a proxy user the resting tile would drift
 *      up on every folded day. The fold therefore mints one derived
 *      `RESTING_HEART_RATE` row per folded PULSE day from the day's RAW
 *      rows at fold time, sourced `COMPUTED` (see below).
 *   2. **DAY-rollup fidelity (mean AND min/max).** The persistent
 *      `MeasurementRollup` DAY bucket stores `min_value` / `max_value` /
 *      `mean`, but it aggregates LIVE `deleted_at IS NULL` rows.
 *      Recomputing it AFTER the fold would aggregate the hourly rows: the
 *      min/max collapse to the extreme HOURLY means (hiding the true
 *      intraday extremes — for SpO2 the overnight-desaturation nadir), and
 *      the mean becomes an UNWEIGHTED mean-of-hourly-means that drifts
 *      whenever the per-hour sample counts differ. So for EVERY dense-tier
 *      type the DAY bucket is recomputed from the RAW rows BEFORE the fold
 *      — capturing the true mean, min, and max — and the post-fold DAY
 *      recompute is skipped. WEEK/MONTH/YEAR recomputes (enqueued by the
 *      pre-fold call) aggregate whatever is live at run time, exactly as
 *      they did against the raw stream's successor rows before.
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
 *     Folded here to hourly-mean rows with the daily min/max preserved on
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
 *
 * One fold grain per tier: every member folds HOURLY. A per-type grain
 * split would fork the write path and the rebuild for no reader benefit.
 */
export const DENSE_INTRADAY_RETENTION_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    "HEART_RATE_VARIABILITY",
    "PULSE",
    "OXYGEN_SATURATION",
  ]);

/**
 * Retention bound (days). Per-sample dense-tier rows older than this window
 * fold to hourly-mean rows and the raw rows tombstone; rows inside the
 * window stay raw so the Stress engine has its intra-day inputs.
 *
 * 90 days comfortably covers the Stress engine's 7-day reference window and
 * lets the intraday pulse day-navigator (S11) page back through a full
 * quarter of true 10-minute-resolution days before it hits the coarser
 * hourly fold. Raised from the original 14-day bound deliberately: a
 * self-hoster's own Postgres volume is the trade-off, not a shared resource,
 * so trading roughly six extra weeks of raw per-sample rows per dense type
 * for three months of full-resolution history is the right default. Days
 * outside the window still fold to hourly means rather than disappearing —
 * `loadIntradayPulse` falls back to that hourly tier so the navigator never
 * renders an empty chart for an older day.
 */
export const DENSE_INTRADAY_RETENTION_DAYS = 90;

/** The stats externalId prefix marks an already-collapsed row. */
const DAILY_STATS_PREFIX = "stats:";

/**
 * Hourly `stats:` externalId for one (type, local-day, local-hour) slot:
 * `stats:<HKIdentifier>:<YYYY-MM-DD>T<HH>` with a zero-padded local hour.
 * Extends the locked `stats:<HK>:<YYYY-MM-DD>` daily family one grain down
 * — the `stats:` prefix is load-bearing: the retention scan's
 * `NOT startsWith('stats:')` predicate is what keeps folded rows out of
 * re-folding, so every row this tier mints MUST stay under it.
 */
export function hourlyStatsExternalId(
  hkIdentifier: string,
  dateKey: string,
  hour: number,
): string {
  return `stats:${hkIdentifier}:${dateKey}T${String(hour).padStart(2, "0")}`;
}

/**
 * Group per-sample rows into per-LOCAL-HOUR buckets (0–23) for the user's
 * timezone. A spring-forward day yields no bucket for the skipped hour (no
 * sample can carry a nonexistent wall-clock time); a fall-back day folds
 * both instants of the repeated hour into one bucket. Pure; exposed for
 * unit testing without Prisma.
 */
export function bucketRowsByLocalHour(
  rows: readonly PerSampleRow[],
  tz: string,
): Map<number, PerSampleRow[]> {
  const byHour = new Map<number, PerSampleRow[]>();
  for (const row of rows) {
    const hour = hourOfDayForUserTz(row.measuredAt, tz);
    const slot = byHour.get(hour) ?? [];
    slot.push(row);
    byHour.set(hour, slot);
  }
  return byHour;
}

/**
 * Adopt-or-mint one hourly `stats:` row inside the caller's transaction.
 *
 * TWO unique indexes can collide on the mint:
 *   A) `(userId, type, source, externalId)` — a row already carrying the
 *      target hourly `stats:` externalId (a prior fold / rebuild pass).
 *   B) `(userId, type, measuredAt, source, sleepStage)` (NULLS NOT
 *      DISTINCT, tombstones included) — any row sitting on the hourly
 *      anchor instant, which may carry a DIFFERENT externalId (a
 *      per-sample row that happened at HH:30, or a sibling stats row).
 *
 * Determinism (VECTOR 1): resolve by index A FIRST — the row already
 * holding the target externalId IS the canonical hourly row by
 * construction. Only when no such row exists fall back to the index-B row
 * physically occupying the anchor. A stable `orderBy: id` pins the pick.
 * Adopting the wrong sibling and stamping the target externalId onto it
 * would otherwise collide with the real `stats:` row on index A.
 *
 * Concurrency (VECTOR 2): the resolve→create is a check-then-act not
 * serialised by the unique index under READ COMMITTED. If a concurrent
 * writer wins the slot between the lookup and the INSERT, the `create`
 * throws P2002 and Postgres aborts the whole transaction. Callers
 * therefore catch P2002 OUTSIDE their transaction (a caught error inside
 * would leave the tx in the aborted `25P02` state) and retry the fold
 * once: on the retry the deterministic lookup finds the now-existing row
 * and ADOPTS it, so the create path never fires twice. Built
 * field-by-field (no spread) per the no-mass-assignment convention.
 */
export async function adoptOrMintHourlyRow(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    type: MeasurementType;
    /** Target hourly `stats:` externalId (index-A identity). */
    externalId: string;
    /** Local HH:30 anchor instant (index-B identity). */
    anchor: Date;
    value: number;
    unit: string;
  },
): Promise<string> {
  const eidRow = await tx.measurement.findFirst({
    where: {
      userId: input.userId,
      type: input.type,
      source: "APPLE_HEALTH",
      externalId: input.externalId,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  // Index-B occupant (`sleepStage` is NULL for these continuous types,
  // matched via the NULLS-NOT-DISTINCT index). At most one row can exist.
  const slotRow = await tx.measurement.findFirst({
    where: {
      userId: input.userId,
      type: input.type,
      source: "APPLE_HEALTH",
      measuredAt: input.anchor,
      sleepStage: null,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const adoptTarget = eidRow ?? slotRow;
  if (adoptTarget) {
    // Pin the adopted row to the anchor, but only when the anchor slot is
    // free or already this row — a DIFFERENT row occupying the slot would
    // otherwise collide on index B. In that rare case the row keeps its
    // existing instant; the `stats:` externalId is the identity,
    // measuredAt is secondary.
    const slotIsFreeForTarget =
      slotRow === null || slotRow.id === adoptTarget.id;
    // Adopt: refresh value, stamp the hourly externalId, optionally
    // re-anchor, and un-tombstone. This coexists with any pre-existing row
    // on the slot instead of colliding with it.
    await tx.measurement.update({
      where: { id: adoptTarget.id },
      data: {
        value: input.value,
        unit: input.unit,
        externalId: input.externalId,
        deletedAt: null,
        ...(slotIsFreeForTarget ? { measuredAt: input.anchor } : {}),
      },
    });
    return adoptTarget.id;
  }

  const created = await tx.measurement.create({
    data: {
      userId: input.userId,
      type: input.type,
      value: input.value,
      unit: input.unit,
      source: "APPLE_HEALTH",
      measuredAt: input.anchor,
      externalId: input.externalId,
    },
    select: { id: true },
  });
  return created.id;
}

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
 * `deriveRestingProxyFromPulse`. Always fed the day's RAW rows (never the
 * hourly means — those flatten the low tail the percentile reads).
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
    /** Hourly `stats:` rows minted / refreshed by the fold. */
    hourlyRowsUpserted: number;
    /**
     * Pre-hourly daily `stats:` rows retired (tombstoned) because the fold
     * minted hourly rows for their day — the late-sync path: raw samples
     * arriving for a day that was folded to the daily grain before
     * v1.28.31. Retired in the SAME transaction as the hourly mint so no
     * reader ever sees the daily and hourly rows live at once.
     */
    dailyRowsRetired: number;
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
 * Run the dense intra-day retention drain. Folds per-sample dense-tier
 * rows older than the retention window into hourly-mean `stats:` rows
 * (user-local hours, anchored at local HH:30) and soft-deletes the raw
 * rows; rows inside the window stay raw. Idempotent — re-invocation after
 * a successful pass converges to zero work because the folded rows are
 * soft-deleted and so excluded from the live scan, and the minted hourly
 * rows are excluded by the `NOT startsWith('stats:')` predicate.
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
      hourlyRowsUpserted: 0,
      dailyRowsRetired: 0,
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

  // The base walks users serially; recordBucket needs the current user's tz
  // for the dry-run hourly fan-out estimate (writeDay never runs on dry-run).
  let currentTz = "Europe/Berlin";

  const { usersScanned } = await runConsolidation<MeasurementType>({
    prismaClient,
    options: { ...options, cutoffHours },
    types: DENSE_INTRADAY_RETENTION_TYPES,
    hkIdentifierForType,
    dailyStatsExternalId,
    statsPrefix: DAILY_STATS_PREFIX,
    // The base's per-day reducedValue is the day MEAN; the hourly fold
    // recomputes per-hour means itself (same `meanBucketValue` reducer, so
    // the two surfaces can never drift), and the day-level value only
    // feeds the summary/dry-run reporting.
    reduce: meanBucketValue,
    // Live per-sample rows for the type, source-scoped to APPLE_HEALTH so
    // manual + Withings spot rows survive. The minted hourly stats rows are
    // excluded by the NOT-startsWith predicate so they are never re-folded;
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
      dayRows,
      sourceRowIds,
      tz,
      dateKey,
    }): Promise<DayWriteOutcome> => {
      const unit = dayRows[0]?.unit ?? "unknown";
      const isPulse = type === "PULSE";
      const hkIdentifier = hkIdentifierForType(type);
      // Unreachable: the base skips types without an HK identifier before
      // scanning; asserted so a future type-set edit fails loud, not by
      // minting a malformed externalId.
      if (!hkIdentifier) {
        throw new Error(`no HK identifier for dense-tier type ${type}`);
      }

      // DAY-rollup fidelity — mean AND min/max (all dense-tier types). The
      // persistent `MeasurementRollup` DAY bucket aggregates LIVE rows;
      // recomputing it AFTER the fold would aggregate the hourly means: the
      // min/max collapse to the extreme hourly MEANS (for SpO2 hiding the
      // overnight-desaturation nadir; for PULSE the resting floor + workout
      // peak) and the mean becomes an unweighted mean-of-hourly-means that
      // drifts whenever per-hour sample counts differ. So the DAY bucket is
      // recomputed from the RAW rows BEFORE the fold, while they are still
      // live, and the post-fold DAY recompute is skipped entirely. The
      // WEEK/MONTH/YEAR recomputes this call enqueues run post-commit
      // against whatever is live then, as before.
      await recomputeBucketsForMeasurement(userId, type, canonicalTimestamp);

      // Fold the day into per-LOCAL-HOUR mean rows, anchored at local
      // HH:30. Sorted for a deterministic write order across runs.
      const byHour = [...bucketRowsByLocalHour(dayRows, tz).entries()].sort(
        (a, b) => a[0] - b[0],
      );

      const foldOnce = async (): Promise<{
        removed: number;
        retiredDaily: boolean;
      }> => {
        let removed = 0;
        let retiredDaily = false;
        await pc.$transaction(async (tx) => {
          const canonicalRowIds: string[] = [];
          for (const [hour, hourRows] of byHour) {
            const rowId = await adoptOrMintHourlyRow(tx, {
              userId,
              type,
              externalId: hourlyStatsExternalId(hkIdentifier, dateKey, hour),
              anchor: canonicalHourlyTimestamp(dateKey, hour, tz),
              value: meanBucketValue(hourRows),
              unit,
            });
            canonicalRowIds.push(rowId);
          }

          // Retire a live pre-hourly DAILY `stats:` row for this day (the
          // late-sync path: raw samples arriving for a day folded to the
          // daily grain before v1.28.31). Same transaction as the hourly
          // mint — an AVG-over-live-rows reader must never see the daily
          // row and the hourly rows live at once (double count).
          const dailyRow = await tx.measurement.findFirst({
            where: {
              userId,
              type,
              source: "APPLE_HEALTH",
              externalId,
              deletedAt: null,
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          if (dailyRow && !canonicalRowIds.includes(dailyRow.id)) {
            await tx.measurement.update({
              where: { id: dailyRow.id },
              data: { deletedAt: new Date() },
            });
            retiredDaily = true;
          }

          // Soft-delete the out-of-window per-sample rows in the same
          // transaction — tombstone, never hard-delete; they remain until
          // the tombstone-retention prune and drop off the live read + this
          // pass's re-run discovery. EXCLUDE the adopted canonical rows: a
          // per-sample row that happened to fall on an hourly anchor is the
          // row just adopted as that hour's mean, so tombstoning it would
          // erase the fold.
          const del = await tx.measurement.updateMany({
            where: {
              id: { in: sourceRowIds, notIn: canonicalRowIds },
              deletedAt: null,
            },
            data: { deletedAt: new Date() },
          });
          removed = del.count;
        });
        return { removed, retiredDaily };
      };

      let foldResult: { removed: number; retiredDaily: boolean };
      try {
        foldResult = await foldOnce();
      } catch (err) {
        if (!isUniqueConstraintViolation(err)) throw err;
        // A concurrent writer won a slot mid-transaction. Retry once: the
        // deterministic lookup now resolves the winning row and adopts it,
        // so this pass cannot create a duplicate.
        foldResult = await foldOnce();
      }
      // Counters mutate OUTSIDE the retryable transaction so a P2002 retry
      // cannot double-count.
      summary.totals.hourlyRowsUpserted += byHour.length;
      if (foldResult.retiredDaily) summary.totals.dailyRowsRetired += 1;

      // iOS#34 — preserve the resting signal for PROXY users. For a user
      // with zero native `RESTING_HEART_RATE` rows, the read-path resolver
      // derives resting from the 20th-percentile of each day's RAW PULSE; the
      // fold has just deleted those rows, so that day's resting figure would
      // vanish (the hourly means flatten the low tail the percentile reads).
      // Mint one derived `RESTING_HEART_RATE` row from the same percentile,
      // sourced `COMPUTED` (distinct from Apple's own resting rows on both
      // unique indexes), so the day reads back as the clean resting series
      // the resolver prefers. Skipped for users WITH native resting rows
      // (the resolver ignores the proxy entirely for them, so a derived row
      // would only double-count).
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

      // No post-fold DAY recompute for ANY dense-tier type — it would
      // overwrite the true raw-derived mean/min/max the pre-fold recompute
      // above captured with hourly-mean-derived approximations (see the
      // fidelity note there).

      return { kind: "written", sourceRowsRemoved: foldResult.removed };
    },
    recordBucket: ({ dayRows, outcome }) => {
      summary.totals.daysConsolidated += 1;
      if (outcome === null) {
        // Dry-run: writeDay never ran, so estimate the hourly fan-out here
        // from the same bucketing the real fold would use.
        summary.totals.hourlyRowsUpserted += bucketRowsByLocalHour(
          dayRows,
          currentTz,
        ).size;
      }
      summary.totals.perSampleRowsSoftDeleted +=
        outcome?.kind === "written"
          ? outcome.sourceRowsRemoved
          : dayRows.length;
    },
    onUserStart: ({ tz }) => {
      currentTz = tz;
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
    `[dense-intraday-retention] done — usersScanned=${summary.totals.usersScanned} daysConsolidated=${summary.totals.daysConsolidated} perSampleRowsSoftDeleted=${summary.totals.perSampleRowsSoftDeleted} hourlyRowsUpserted=${summary.totals.hourlyRowsUpserted} dailyRowsRetired=${summary.totals.dailyRowsRetired} derivedRestingRowsUpserted=${summary.totals.derivedRestingRowsUpserted}${options.dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}
