/**
 * v1.10.0 — computed scores (WX-C). The Recovery score ENGINE + persistence.
 *
 * This is the PERSISTING counterpart to the compute-on-read `READINESS`
 * derived engine (`src/lib/insights/derived/readiness.ts`). The derived
 * engine answers a live request with a `Derived<T>`; this module reuses that
 * exact math and writes the result as a queryable / chartable /
 * iOS-readable `Measurement` row so the score has the same first-class
 * storage shape as a vital — a daily 0–100 series the dashboard, charts, and
 * the native client can read without recomputing.
 *
 * The row is:
 *   - `type   = RECOVERY_SCORE`
 *   - `source = COMPUTED`        (server-owned; a client can never POST it)
 *   - `unit   = "score"`         (the canonical unit; see `validations/measurement`)
 *   - `value  = 0..100`          (plausibility-pinned to {min:0, max:100})
 *   - `externalId = recovery:YYYY-MM-DD` (the per-day idempotency key)
 *
 * Idempotent per user per day: a re-run upserts on
 * `(userId, type, source, externalId)` rather than minting a duplicate, so
 * the nightly job is safe to re-fire and a same-day re-compute (e.g. after a
 * late watch sync) overwrites the day's score in place.
 *
 * Honest confidence: the score is only stored when the underlying readiness
 * blend reaches its minimum-component floor (`READINESS_MIN_COMPONENTS`).
 * Below that the engine returns `insufficient` and NO row is written — the
 * series never carries a headline derived from 1-of-N signals.
 *
 * Standard / framing: RHR elevation + HRV (SDNN) suppression as recovery
 * markers — Plews et al. 2013, Sports Medicine 43(9):773–781; Buchheit 2014,
 * Frontiers in Physiology 5:73 (same lineage as the READINESS derived
 * engine). The score is descriptive — a daily wellness proxy, NOT a clinical
 * or training-recovery assessment, and it is excluded from the doctor PDF.
 *
 * Server-only — never call this on a page visit. It runs from the nightly
 * pg-boss job in `src/lib/jobs/recovery-score.ts`.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  computeReadiness,
  type ReadinessValue,
} from "@/lib/insights/derived/readiness";
import type { BaselineProfile } from "@/lib/insights/derived/baseline";
import type { Derived } from "@/lib/insights/derived/types";

/** The per-day idempotency-key prefix for a stored Recovery score row. */
export const RECOVERY_SCORE_EXTERNAL_ID_PREFIX = "recovery:";

/**
 * The UTC calendar day a `now` falls in, as `YYYY-MM-DD`. The Recovery
 * series is one row per UTC day — the same day-keying the rollup tier and
 * the daily-mean consolidation use, so the score lines up with the buckets
 * it summarises.
 */
export function recoveryDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The full `externalId` for a given day's Recovery score row. */
export function recoveryExternalId(now: Date): string {
  return `${RECOVERY_SCORE_EXTERNAL_ID_PREFIX}${recoveryDayKey(now)}`;
}

/**
 * The canonical timestamp a stored Recovery row carries: noon UTC on the
 * scored day. Noon (not midnight) keeps the row inside its own UTC day under
 * any reasonable display-timezone offset, mirroring the daily-stats
 * convention so a chart never mis-buckets the point at a day boundary.
 */
export function recoveryMeasuredAt(now: Date): Date {
  return new Date(`${recoveryDayKey(now)}T12:00:00.000Z`);
}

export interface RecoveryComputeResult {
  /** The readiness blend the score is read from (exposed for the job log + tests). */
  readiness: Derived<ReadinessValue>;
  /** The 0..100 score to persist, or null when the blend was insufficient. */
  score: number | null;
}

/**
 * Compute the Recovery score for one user as of `now`. Pure of persistence —
 * the job calls this, then writes the row. Reuses the READINESS derived
 * engine verbatim (its RHR/HRV/sleep/respiratory deviation blend IS the
 * recovery model) so the two surfaces can never drift.
 */
export async function computeRecoveryScore(
  prisma: PrismaClient,
  userId: string,
  profile: BaselineProfile,
  now: Date,
): Promise<RecoveryComputeResult> {
  // The derived engine reads `@/lib/db`'s prisma; it does not accept an
  // injected client. We only pass `prisma` through for the profile read in
  // the helper below so the job can share one client. `now` is injected so
  // the result is deterministic for tests.
  const readiness = await computeReadiness(userId, profile, { now });
  const score = readiness.status === "ok" ? readiness.value.score : null;
  return { readiness, score };
}

/**
 * Build the `BaselineProfile` the readiness blend needs from the user row —
 * the same shape the live `/api/insights/derived` route builds. `prisma` is
 * the (worker) client so the job shares one connection.
 */
export async function loadRecoveryProfile(
  prisma: PrismaClient,
  userId: string,
): Promise<BaselineProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dateOfBirth: true, gender: true, heightCm: true },
  });
  const sex =
    user?.gender === "MALE" || user?.gender === "FEMALE" ? user.gender : null;
  return {
    ageYears: getAgeFromDateOfBirth(user?.dateOfBirth ?? null),
    sex,
    heightCm: user?.heightCm ?? null,
  };
}

export interface PersistRecoveryResult {
  /** "stored" when a row was upserted; "insufficient" when the blend gated. */
  outcome: "stored" | "insufficient";
  /** The persisted score, or null when insufficient. */
  score: number | null;
}

/**
 * Compute + persist one user's Recovery score for the `now` day. Upserts on
 * the `(userId, type, source, externalId)` key so a re-run overwrites the
 * day's row in place rather than duplicating it. Writes NOTHING when the
 * readiness blend is insufficient — no phantom score from too few signals.
 */
export async function persistRecoveryScore(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<PersistRecoveryResult> {
  const profile = await loadRecoveryProfile(prisma, userId);
  const { score } = await computeRecoveryScore(prisma, userId, profile, now);

  if (score === null) {
    return { outcome: "insufficient", score: null };
  }

  const externalId = recoveryExternalId(now);
  const measuredAt = recoveryMeasuredAt(now);

  await prisma.measurement.upsert({
    where: {
      userId_type_source_externalId: {
        userId,
        type: "RECOVERY_SCORE",
        source: "COMPUTED",
        externalId,
      },
    },
    create: {
      userId,
      type: "RECOVERY_SCORE",
      source: "COMPUTED",
      value: score,
      unit: "score",
      measuredAt,
      externalId,
    },
    update: {
      value: score,
      measuredAt,
    },
  });

  return { outcome: "stored", score };
}
