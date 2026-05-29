/**
 * v1.5.6 — consolidate pre-v1.5.0 legacy step rows into one daily-total
 * row per user per calendar day.
 *
 * Pre-v1.5.0, HealthKit step samples landed at sampling granularity —
 * hundreds-to-thousands of `ACTIVITY_STEPS` rows per day. Post-v1.5.0,
 * iOS emits one overwrite-able daily-total row carrying the
 * `stats:HKQuantityTypeIdentifierStepCount:YYYY-MM-DD` externalId
 * (see `src/app/api/measurements/batch/route.ts` stats-overwrite logic).
 * This pass collapses the legacy granular rows into the same canonical
 * daily shape so historical step data reads consistently.
 *
 * Per user × calendar day (anchored to `User.timezone`):
 *   1. SELECT live (`deletedAt IS NULL`) `ACTIVITY_STEPS` rows whose
 *      `externalId` does NOT start with the daily-stats prefix.
 *   2. Group into per-day buckets in the user's timezone.
 *   3. SUM the legacy values for the day.
 *   4. UPSERT the canonical daily-total row keyed by
 *      `stats:HKQuantityTypeIdentifierStepCount:<dateKey>`. If a daily
 *      total already exists for the day (post-v1.5.0 iOS already wrote
 *      one), the existing total is the source of truth — it is NOT
 *      overwritten and the legacy sum is NOT folded in (avoids double-
 *      counting: the post-v1.5.0 row already represents the true daily
 *      total HealthKit computed). The legacy granular rows are still
 *      soft-deleted so they stop polluting the per-sample read path.
 *   5. SOFT-DELETE (set `deletedAt`) the legacy granular rows — they
 *      stay in the table as an audit/backup trail. Sampling-granularity
 *      loss is explicitly accepted.
 *
 * Idempotent: the discovery query (`enqueueBootTimeStepConsolidation`)
 * matches only users still holding live legacy step rows, so a second
 * run converges to zero work. Within a run, soft-deleted legacy rows
 * are excluded from the scan, so a re-run after a partial pass never
 * re-aggregates an already-consolidated day.
 *
 * Runs on pg-boss (`STEP_CONSOLIDATION_QUEUE`), not a CLI — the
 * production standalone image strips `tsx`. Modelled on the
 * `rollup-full-backfill` boot-time converging-backfill pattern.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { dailyStatsExternalId } from "./apple-health-mapping";
import {
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  type PerSampleRow,
} from "./drain-per-sample-cumulative";

/** HealthLog measurement type that carries step counts. */
const STEP_TYPE = "ACTIVITY_STEPS" as const;

/** Canonical HealthKit identifier for the step type. */
const STEP_HK_IDENTIFIER = "HKQuantityTypeIdentifierStepCount";

/**
 * Daily-total externalId prefix. Legacy rows that do NOT start with
 * this are candidates for consolidation; the daily-total row this pass
 * mints carries the full `stats:HKQuantityTypeIdentifierStepCount:<day>`
 * externalId.
 */
export const STEP_DAILY_STATS_PREFIX = `stats:${STEP_HK_IDENTIFIER}:`;

/** Per-(user, day) action summary. */
export interface StepConsolidationBucket {
  userId: string;
  /** Calendar-day key in the user's timezone (`YYYY-MM-DD`). */
  dateKey: string;
  /** Number of legacy granular rows folded for this day. */
  legacyRowCount: number;
  /** SUM of the legacy granular values for the day. */
  legacySum: number;
  /** Whether a `stats:` daily total already existed for this day. */
  hadExistingTotal: boolean;
  /** ISO-8601 canonical timestamp (local-noon of the user's day). */
  canonicalTimestamp: string;
  /** Resulting daily-total `externalId`. */
  externalId: string;
}

export interface StepConsolidationSummary {
  /** Did the run actually write to the DB (false for `dryRun`). */
  dryRun: boolean;
  /** Per-user-day buckets the pass rewrote (or would rewrite). */
  buckets: StepConsolidationBucket[];
  totals: {
    usersScanned: number;
    daysConsolidated: number;
    legacyRowsSoftDeleted: number;
    dailyRowsUpserted: number;
    /** Days skipped because a `stats:` total already existed. */
    daysFoldedIntoExisting: number;
    /**
     * Days skipped because the per-day mint hit a unique-constraint
     * collision (P2002) and the transaction rolled back. Counted, logged,
     * and stepped over so a single poison day can never strand the rest
     * of the pass — the pass stays converging for every other day.
     */
    daysSkippedOnConflict: number;
  };
}

/** True for a Prisma unique-constraint violation (P2002). */
function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export interface StepConsolidationOptions {
  /** Limit the pass to a single user. Default = every user. */
  userId?: string;
  /** Preview-only mode — no DB writes. */
  dryRun?: boolean;
  /** Logger sink — defaults to `console.log`. */
  log?: (line: string) => void;
}

/**
 * Group legacy step rows into per-day buckets in the user's timezone.
 * Rows already in the daily-stats shape are skipped — they are the
 * canonical total, not a legacy sample. Exposed for unit testing the
 * bucketing semantics without booting Prisma.
 */
export function bucketLegacyStepRows(
  rows: readonly PerSampleRow[],
  tz: string,
): Map<string, PerSampleRow[]> {
  const byDay = new Map<string, PerSampleRow[]>();
  for (const row of rows) {
    if (
      row.externalId !== null &&
      row.externalId.startsWith(STEP_DAILY_STATS_PREFIX)
    ) {
      continue;
    }
    const key = dayKeyForUserTz(row.measuredAt, tz);
    const slot = byDay.get(key) ?? [];
    slot.push(row);
    byDay.set(key, slot);
  }
  return byDay;
}

/** SUM the values in a per-day legacy bucket. */
export function sumLegacyStepValues(rows: readonly PerSampleRow[]): number {
  let acc = 0;
  for (const row of rows) acc += row.value;
  return acc;
}

/**
 * Run the step consolidation. Idempotent — re-invocation after a
 * successful pass reports zero days consolidated because the legacy
 * rows are soft-deleted (and so excluded from the live scan).
 *
 * Does NOT enforce any auth gate — the queue handler owns that concern.
 */
export async function consolidateLegacySteps(
  prismaClient: PrismaClient,
  options: StepConsolidationOptions = {},
): Promise<StepConsolidationSummary> {
  const dryRun = options.dryRun ?? false;
  const log = options.log ?? ((line) => console.log(line));

  const users = options.userId
    ? await prismaClient.user.findMany({
        where: { id: options.userId },
        select: { id: true, timezone: true },
      })
    : await prismaClient.user.findMany({
        select: { id: true, timezone: true },
      });

  const summary: StepConsolidationSummary = {
    dryRun,
    buckets: [],
    totals: {
      usersScanned: users.length,
      daysConsolidated: 0,
      legacyRowsSoftDeleted: 0,
      dailyRowsUpserted: 0,
      daysFoldedIntoExisting: 0,
      daysSkippedOnConflict: 0,
    },
  };

  for (const user of users) {
    const tz =
      user.timezone && user.timezone.length > 0
        ? user.timezone
        : "Europe/Berlin";

    // Live legacy step rows whose externalId is NOT the daily-stats
    // shape. The `stats:` daily-total row (if present) is read
    // separately below per day; we exclude it here so it is never
    // soft-deleted. Soft-deleted rows (`deletedAt IS NOT NULL`) are
    // excluded so a re-run after a partial pass never re-aggregates.
    const legacyRows = (await prismaClient.measurement.findMany({
      where: {
        userId: user.id,
        type: STEP_TYPE,
        deletedAt: null,
        NOT: { externalId: { startsWith: STEP_DAILY_STATS_PREFIX } },
      },
      select: {
        id: true,
        type: true,
        value: true,
        measuredAt: true,
        externalId: true,
      },
      orderBy: { measuredAt: "asc" },
    })) as PerSampleRow[];

    if (legacyRows.length === 0) continue;

    log(`[step-consolidation] user=${user.id} tz=${tz} legacyRows=${legacyRows.length}${dryRun ? " (dry-run)" : ""}`);

    const byDay = bucketLegacyStepRows(legacyRows, tz);

    for (const [dateKey, dayRows] of byDay) {
      if (dayRows.length === 0) continue;

      const legacySum = sumLegacyStepValues(dayRows);
      const canonicalTs = canonicalDailyTimestamp(dateKey, tz);
      const externalId = dailyStatsExternalId(STEP_HK_IDENTIFIER, dateKey);

      // Does a post-v1.5.0 daily total already exist for this day? If so
      // it is the source of truth (HealthKit's own daily aggregate) —
      // we do NOT overwrite it and do NOT add the legacy sum on top
      // (that would double-count). We still soft-delete the legacy rows.
      // `source` is deliberately omitted from this probe (the upsert below
      // pins `source: "MANUAL"`): a daily total written by iOS lands as
      // `APPLE_HEALTH`, and matching it here is what prevents minting a
      // second MANUAL total on top of it. The asymmetry with the upsert
      // `where` is intentional, not a bug.
      const existingTotal = await prismaClient.measurement.findFirst({
        where: {
          userId: user.id,
          type: STEP_TYPE,
          externalId,
          deletedAt: null,
        },
        select: { id: true },
      });
      const hadExistingTotal = existingTotal !== null;

      const bucket: StepConsolidationBucket = {
        userId: user.id,
        dateKey,
        legacyRowCount: dayRows.length,
        legacySum,
        hadExistingTotal,
        canonicalTimestamp: canonicalTs.toISOString(),
        externalId,
      };
      summary.buckets.push(bucket);
      summary.totals.daysConsolidated += 1;
      if (hadExistingTotal) summary.totals.daysFoldedIntoExisting += 1;

      const ids = dayRows.map((r) => r.id);

      if (!dryRun) {
        try {
          await prismaClient.$transaction(async (tx) => {
            if (!hadExistingTotal) {
              // Mint the canonical daily-total row. The unique index
              // (userId, type, source, externalId) makes the upsert
              // idempotent across re-runs. Source is MANUAL — these are
              // historical rows whose original sampling source is no
              // longer meaningful once collapsed; the externalId carries
              // the canonical daily-stats shape. Built field-by-field
              // (no spread) per the no-mass-assignment convention.
              await tx.measurement.upsert({
                where: {
                  userId_type_source_externalId: {
                    userId: user.id,
                    type: STEP_TYPE,
                    source: "MANUAL",
                    externalId,
                  },
                },
                create: {
                  userId: user.id,
                  type: STEP_TYPE,
                  value: legacySum,
                  unit: "steps",
                  source: "MANUAL",
                  measuredAt: canonicalTs,
                  externalId,
                },
                update: {
                  value: legacySum,
                  measuredAt: canonicalTs,
                  deletedAt: null,
                },
              });
              summary.totals.dailyRowsUpserted += 1;
            }

            // Soft-delete the legacy granular rows in the same
            // transaction. Tombstone, never hard-delete — they remain as
            // an audit/backup trail. `deletedAt` excludes them from every
            // live read and from this pass's own re-run discovery.
            const del = await tx.measurement.updateMany({
              where: { id: { in: ids }, deletedAt: null },
              data: { deletedAt: new Date() },
            });
            summary.totals.legacyRowsSoftDeleted += del.count;
          });
        } catch (err) {
          // A pre-existing row can collide on the second unique index
          // (userId, type, measuredAt, source, sleepStage) when a MANUAL
          // step row already sits at this day's canonical-noon instant
          // with a null externalId — the mint's `create` branch fires
          // (the upsert keys on externalId, which differs) and trips that
          // index, rolling back the soft-delete too. Skipping the day
          // (rather than aborting the whole user) keeps the pass
          // converging: the legacy rows stay live but every other day
          // still consolidates, and the run does not re-throw on every
          // boot. Non-P2002 errors are genuine failures — rethrow so
          // pg-boss retries.
          if (!isUniqueConstraintViolation(err)) throw err;
          summary.totals.daysConsolidated -= 1;
          summary.totals.daysSkippedOnConflict += 1;
          summary.buckets.pop();
          log(
            `[step-consolidation] user=${user.id} day=${dateKey} skipped — unique-constraint conflict on mint`,
          );
        }
      } else {
        if (!hadExistingTotal) summary.totals.dailyRowsUpserted += 1;
        summary.totals.legacyRowsSoftDeleted += ids.length;
      }
    }

    log(
      `[step-consolidation] user=${user.id} complete days=${byDay.size}${dryRun ? " (dry-run)" : ""}`,
    );
  }

  log(
    `[step-consolidation] done — usersScanned=${summary.totals.usersScanned} daysConsolidated=${summary.totals.daysConsolidated} legacyRowsSoftDeleted=${summary.totals.legacyRowsSoftDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted} daysFoldedIntoExisting=${summary.totals.daysFoldedIntoExisting} daysSkippedOnConflict=${summary.totals.daysSkippedOnConflict}${dryRun ? " (dry-run)" : ""}`,
  );

  return summary;
}
