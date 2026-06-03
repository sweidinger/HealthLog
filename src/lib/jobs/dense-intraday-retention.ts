/**
 * v1.10.0 — pg-boss queue + boot-time converging backfill for the dense
 * intra-day retention drain of daytime HRV / heart-rate samples.
 *
 * Modelled on `mean-consolidation.ts`: a discovery query enqueues one job
 * per user still holding live per-sample dense-tier rows OLDER than the
 * retention window, the per-user handler runs `runDenseIntradayRetention`,
 * and the pass is idempotent across reboots (folded rows are soft-deleted
 * so they drop off the discovery list).
 *
 * Unlike the daily-mean consolidation, this pass scopes to the dense-tier
 * types (`HEART_RATE_VARIABILITY`, `PULSE`) and keeps the last
 * `DENSE_INTRADAY_RETENTION_DAYS` of raw per-sample rows so the Stress
 * engine still has its intra-day SDNN shape; only out-of-window samples
 * fold to a daily mean.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  runDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_TYPES,
  DENSE_INTRADAY_RETENTION_DAYS,
} from "@/lib/measurements/dense-intraday-retention";

export const DENSE_INTRADAY_RETENTION_QUEUE = "dense-intraday-retention";

/**
 * Serial concurrency — the drain walks every out-of-window per-sample
 * dense-tier row for a user and writes a transaction per day;
 * concurrency-1 keeps it from crowding the request pool, matching the
 * mean-consolidation + step-consolidation convention.
 */
export const DENSE_INTRADAY_RETENTION_CONCURRENCY = 1;

/**
 * Daily at 03:50 Europe/Berlin — inside the existing 03:xx maintenance
 * window, after the daily-mean consolidation that the cumulative + mean
 * drains run, and before the 04:30 insight pre-generation + 04:45
 * recovery-score so the rollup tier reflects the fold before the nightly
 * scores read it.
 */
export const DENSE_INTRADAY_RETENTION_CRON = "50 3 * * *";

/**
 * Boot-discovery jobs start only after this delay (seconds) so the
 * catch-up drain never competes with the startup storm — the deploy
 * container recreate, the Prisma migration, the other boot-time backfills
 * (rollup / mean- + step-consolidation / mood / medication-compliance),
 * and the foreground health-checks all share one connection pool. Running
 * the transaction-per-day drain into that contention exhausted the pool on
 * a data-heavy tenant (`P2028: Unable to start a transaction in the given
 * time`), starving `/api/health` into a restart loop. Deferring past the
 * boot window restores the pre-v1.10 boot profile; the scheduled 03:50
 * cron is unaffected, and the per-user jobs still drain serially
 * (concurrency 1) once the delay elapses.
 */
export const DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS = 600;

/**
 * Kill-switch, default OFF. The drain folds out-of-window per-sample rows
 * into one daily-mean `stats:` row, but its canonical-timestamp upsert
 * collides with an already-present daily row on the
 * `(user_id, type, measured_at, source, sleep_stage)` unique constraint
 * (`P2002`) on real data — a fold-coexistence bug the mocked unit tests
 * could not surface. Until the fold is reworked + integration-tested
 * against real rows, the drain is disabled: the boot-discovery enqueues
 * nothing, the nightly walk is skipped, and the per-user handler no-ops so
 * any already-queued backlog completes harmlessly instead of erroring.
 * Re-enable with `DENSE_INTRADAY_RETENTION_ENABLED=true` once fixed. The
 * Stress proxy degrades gracefully on sparse intra-day data meanwhile.
 */
export const DENSE_INTRADAY_RETENTION_ENABLED =
  process.env.DENSE_INTRADAY_RETENTION_ENABLED === "true";

export interface DenseIntradayRetentionPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user queue handler. Runs the dense-tier retention drain for one
 * account and returns the summary totals so the worker can log them.
 */
export async function runDenseIntradayRetentionForUser(
  userId: string,
): Promise<{ daysConsolidated: number; perSampleRowsSoftDeleted: number }> {
  // Kill-switch: no-op so any already-queued backlog completes cleanly
  // (drains the queue) instead of erroring on the P2002 fold collision.
  if (!DENSE_INTRADAY_RETENTION_ENABLED) {
    return { daysConsolidated: 0, perSampleRowsSoftDeleted: 0 };
  }
  const summary = await runDenseIntradayRetention(prisma, {
    userId,
    log: () => {
      // Silent inside the queue handler — the worker logs the totals.
    },
  });
  annotate({
    action: {
      name: "measurement.dense_intraday.retain",
      details: {
        days: summary.totals.daysConsolidated,
        per_sample_rows_soft_deleted: summary.totals.perSampleRowsSoftDeleted,
        daily_rows_upserted: summary.totals.dailyRowsUpserted,
      },
    },
  });
  return {
    daysConsolidated: summary.totals.daysConsolidated,
    perSampleRowsSoftDeleted: summary.totals.perSampleRowsSoftDeleted,
  };
}

/**
 * Boot-time discovery. Finds every user holding at least one LIVE
 * per-sample dense-tier row (an `APPLE_HEALTH` row of a
 * `DENSE_INTRADAY_RETENTION_TYPES` type whose externalId does NOT start
 * with the daily-stats prefix, that is not tombstoned, AND whose
 * `measuredAt` is older than the retention window) and enqueues one
 * retention job per account.
 *
 * Idempotent across reboots: once a user's out-of-window per-sample rows
 * are soft-deleted, the predicate drops them from the discovery set.
 * pg-boss `singletonKey` coalesces duplicate sends. Best-effort: errors
 * are returned through the result value so worker boot never fails because
 * of a retention miss.
 */
export async function enqueueBootTimeDenseIntradayRetention(): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  // Kill-switch: enqueue nothing while the drain is disabled.
  if (!DENSE_INTRADAY_RETENTION_ENABLED) {
    return { enqueued: 0, skipped: 0, error: null };
  }
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    // The dense-tier type set is a closed compile-time list of enum
    // members; splice-free — Prisma binds the `type IN (...)` array as
    // parameters.
    const types = Array.from(DENSE_INTRADAY_RETENTION_TYPES);
    if (types.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    const windowStart = new Date(
      Date.now() - DENSE_INTRADAY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );

    const users = await prisma.measurement.findMany({
      where: {
        source: "APPLE_HEALTH",
        type: { in: types },
        deletedAt: null,
        NOT: { externalId: { startsWith: "stats:" } },
        measuredAt: { lt: windowStart },
      },
      select: { userId: true },
      distinct: ["userId"],
    });

    if (users.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of users) {
      const payload: DenseIntradayRetentionPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(DENSE_INTRADAY_RETENTION_QUEUE, payload, {
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
        // Defer past the boot storm so the drain never contends with
        // startup + foreground for the shared connection pool.
        startAfter: DENSE_INTRADAY_RETENTION_BOOT_DELAY_SECONDS,
        singletonKey: `dense-intraday-retention|${userId}`,
      });
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
