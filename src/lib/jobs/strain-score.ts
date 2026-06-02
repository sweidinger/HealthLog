/**
 * v1.10.0 — computed scores (WX-E). Nightly Strain-score computation + store.
 *
 * Once a night this cron computes each eligible user's Strain score from
 * the day's per-workout heart-rate series (`WorkoutSamples`, WX-D) plus
 * active-energy burned, via Banister's TRIMP cardio-load model (see
 * `src/lib/insights/strain-score.ts`), and persists it as a `COMPUTED
 * STRAIN_SCORE` Measurement row. The score is never computed on a page
 * visit.
 *
 * Idempotent per user per day: the per-user persist upserts on
 * `(userId, type, source, externalId)` with `externalId = strain:YYYY-MM-DD`,
 * so a re-fired cron tick (or a manual re-run) overwrites the day's row in
 * place. A user with no usable cardio-load input that day gets NO row.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import { persistStrainScore } from "@/lib/insights/strain-score";

export const STRAIN_SCORE_QUEUE = "strain-score-compute";

/**
 * Daily at 04:55 Europe/Berlin — inside the existing maintenance window,
 * after the recovery-score (04:45) + stress-score (04:50) passes so the
 * nightly score writes stay ordered and don't pile on one boss poll.
 */
export const STRAIN_SCORE_CRON = "55 4 * * *";

/** Per-run user cap — same starvation guard the other score passes use. */
export const STRAIN_SCORE_BATCH_CAP = 500;

/** Trailing window (days) a user must have a recent strain-input row in. */
export const STRAIN_SCORE_RECENCY_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StrainScoreRunResult {
  considered: number;
  stored: number;
  insufficient: number;
  errored: number;
}

/**
 * Discover users worth scoring tonight: anyone with a workout started in the
 * recency window OR an `ACTIVE_ENERGY_BURNED` row in it. A user with neither
 * cannot produce a Strain score, so skipping them keeps the pass cheap.
 * Bounded by `cap`.
 */
export async function findStrainScoreCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<string[]> {
  const since = new Date(now.getTime() - STRAIN_SCORE_RECENCY_DAYS * MS_PER_DAY);
  const [workoutUsers, energyUsers] = await Promise.all([
    prisma.workout.findMany({
      where: { startedAt: { gte: since } },
      select: { userId: true },
      distinct: ["userId"],
      take: cap,
    }),
    prisma.measurement.findMany({
      where: {
        type: "ACTIVE_ENERGY_BURNED",
        deletedAt: null,
        measuredAt: { gte: since },
      },
      select: { userId: true },
      distinct: ["userId"],
      take: cap,
    }),
  ]);
  const ids = new Set<string>();
  for (const r of workoutUsers) ids.add(r.userId);
  for (const r of energyUsers) ids.add(r.userId);
  return Array.from(ids).slice(0, cap);
}

/**
 * Run one Strain-score pass. Pure of pg-boss so the unit test drives it
 * directly. Each user is scored independently; a single user's error is
 * recorded and the pass continues.
 */
export async function runStrainScore(
  prisma: PrismaClient,
  options: { now?: Date; cap?: number } = {},
): Promise<StrainScoreRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? STRAIN_SCORE_BATCH_CAP;

  const userIds = await findStrainScoreCandidates(prisma, now, cap);

  let stored = 0;
  let insufficient = 0;
  let errored = 0;
  for (const userId of userIds) {
    try {
      const result = await persistStrainScore(prisma, userId, now);
      if (result.outcome === "stored") stored += 1;
      else insufficient += 1;
    } catch {
      errored += 1;
    }
  }

  annotate({
    action: {
      name: "insights.strain.compute",
      details: { considered: userIds.length, stored, insufficient, errored },
    },
  });

  return { considered: userIds.length, stored, insufficient, errored };
}
