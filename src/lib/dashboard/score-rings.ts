/**
 * v1.27.7 — hero score-ring resolution for the dashboard snapshot.
 *
 * Resolves the user-selected `selectedScoreRings` (max 3, closed
 * `SCORE_RING_IDS` set) into `{ id, score, band }` entries the hero
 * renders next to the health-score ring:
 *
 *   - `READINESS` / `RECOVERY_SCORE` / `SLEEP_SCORE` call the SAME
 *     `computeDerivedMetric` dispatcher the `/api/insights/derived`
 *     batch route uses (profile loaded once via the shared
 *     `loadBaselineProfile`) — no score logic is re-derived here, and a
 *     non-`ok` compute (insufficient data, engine gate) simply yields no
 *     ring, mirroring the wellness strip's self-gating.
 *   - `MED_COMPLIANCE` is the pooled 7-day adherence across active
 *     non-PRN medications through the canonical `calculateCompliance`
 *     engine (the exact per-medication pattern the targets tile and the
 *     health-score pillar use): per-med `ComplianceResult`s are pooled
 *     as Σtaken / Σ(taken + missed) — skips stay out of the denominator,
 *     matching the per-medication rate semantics — and banded on the
 *     same ≥90 / ≥70 thresholds the targets-tile classification carries.
 *
 * Module gating rides the client-safe `SCORE_RING_MODULE` map in
 * `@/lib/dashboard-layout` (mirroring the derived routes'
 * `DERIVED_MODULE`: readiness/recovery → recovery module, sleep score →
 * sleep module, MED_COMPLIANCE → medications) plus the `insights` gate
 * every derived read sits behind.
 *
 * Every ring resolves fail-soft: a throwing engine drops its ring, never
 * the snapshot.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { ModuleKey } from "@/lib/modules/gate";
import {
  SCORE_RING_IDS,
  SCORE_RING_MODULE,
  type ScoreRingId,
} from "@/lib/dashboard-layout";
import {
  computeDerivedMetric,
  loadBaselineProfile,
  isDerivedOk,
  type DerivedMetricId,
} from "@/lib/insights/derived";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";

export type ScoreRingBand = "green" | "yellow" | "red";

/** One resolved hero ring — score + band only, no component breakdown. */
export interface DashboardScoreRing {
  id: ScoreRingId;
  /** The 0..100 score (rounded). */
  score: number;
  band: ScoreRingBand;
}

/** The derived-registry id behind each derived ring (identity mapping). */
const DERIVED_RING_METRIC: Partial<Record<ScoreRingId, DerivedMetricId>> = {
  READINESS: "READINESS",
  RECOVERY_SCORE: "RECOVERY_SCORE",
  SLEEP_SCORE: "SLEEP_SCORE",
};

/**
 * Adherence % → band, on the thresholds the targets tile's
 * MEDICATION_COMPLIANCE classification already uses (≥90 "very good" /
 * ≥70 "good" / below "low"), so the ring and the targets surface can
 * never disagree on colour for the same rate.
 */
export function complianceBandForRate(rate: number): ScoreRingBand {
  if (rate >= 90) return "green";
  if (rate >= 70) return "yellow";
  return "red";
}

/** The compute payload slice every derived score ring reads. */
interface ScoreBandValue {
  score: number;
  band: ScoreRingBand;
}

/**
 * Pooled 7-day medication adherence, or `null` when nothing was expected
 * (no active non-PRN medication, or no due slot in the window) — the
 * ring self-gates instead of asserting a hollow 100%.
 */
async function resolveMedComplianceRing(
  prisma: PrismaClient,
  userId: string,
  userTz: string,
  now: Date,
): Promise<DashboardScoreRing | null> {
  const medications = await prisma.medication.findMany({
    // As-needed (PRN) medications carry no expected doses and are
    // excluded from every compliance rate (the v1.16.11 rule).
    where: { userId, active: true, asNeeded: false },
    select: {
      id: true,
      createdAt: true,
      startsOn: true,
      endsOn: true,
      oneShot: true,
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // Archived schedule eras + pause eras so a past day scores against
      // the schedule that was live then and paused days drop out of the
      // denominator — the same context every compliance caller threads.
      scheduleRevisions: {
        orderBy: { validFrom: "asc" },
        select: {
          id: true,
          validFrom: true,
          validUntil: true,
          payload: true,
          supersededByRevisionId: true,
        },
      },
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });
  if (medications.length === 0) return null;

  // 30 days of intake events even though the rate window is 7: rolling /
  // interval cadences anchor `nextDue` off the last non-skipped take,
  // which can sit before the window start (the health-score pillar
  // fetches the same margin).
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const intakeEvents = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      deletedAt: null,
      medicationId: { in: medications.map((m) => m.id) },
      scheduledFor: { gte: since, lte: now },
    },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });
  const eventsByMed = new Map<string, typeof intakeEvents>();
  for (const ev of intakeEvents) {
    const list = eventsByMed.get(ev.medicationId);
    if (list) list.push(ev);
    else eventsByMed.set(ev.medicationId, [ev]);
  }

  let taken = 0;
  let missed = 0;
  for (const med of medications) {
    const events = eventsByMed.get(med.id) ?? [];
    const medicationContext = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(events),
      userTz,
    );
    const result = calculateCompliance(
      events,
      med.schedules,
      7,
      med.createdAt,
      {
        now,
        medicationContext,
      },
    );
    taken += result.taken;
    missed += result.missed;
  }

  const denominator = taken + missed;
  if (denominator === 0) return null;
  const rate = Math.min(100, Math.round((taken / denominator) * 100));
  return {
    id: "MED_COMPLIANCE",
    score: rate,
    band: complianceBandForRate(rate),
  };
}

/**
 * Resolve the selected hero rings against the module map. Selection
 * order is preserved; rings without data drop out. Every ring is
 * fail-soft on its own — one throwing engine never takes the row (or
 * the snapshot) down.
 */
export async function buildScoreRingsBlock(
  prisma: PrismaClient,
  userId: string,
  userTz: string,
  selected: ScoreRingId[],
  modules: Record<ModuleKey, boolean>,
  now: Date,
): Promise<DashboardScoreRing[]> {
  const eligible = selected.filter((id) => {
    if (!(SCORE_RING_IDS as readonly string[]).includes(id)) return false;
    if (modules[SCORE_RING_MODULE[id]] === false) return false;
    // The derived scores are an insights-layer read everywhere else
    // (`/api/insights/derived*` sits behind the insights module) — the
    // snapshot honours the same gate.
    if (DERIVED_RING_METRIC[id] && modules.insights === false) return false;
    return true;
  });
  if (eligible.length === 0) return [];

  // Profile loaded ONCE via the shared loader (the batch-route pattern);
  // only when a derived ring is actually selected.
  const needsProfile = eligible.some((id) => DERIVED_RING_METRIC[id]);
  const profile = needsProfile
    ? await loadBaselineProfile(prisma, userId)
    : null;

  const resolved = await Promise.all(
    eligible.map(async (id): Promise<DashboardScoreRing | null> => {
      try {
        if (id === "MED_COMPLIANCE") {
          return await resolveMedComplianceRing(prisma, userId, userTz, now);
        }
        const metric = DERIVED_RING_METRIC[id];
        if (!metric || !profile) return null;
        const derived = await computeDerivedMetric({
          metric,
          userId,
          profile,
          now,
        });
        if (!isDerivedOk(derived)) return null;
        const value = derived.value as ScoreBandValue;
        if (typeof value?.score !== "number" || !Number.isFinite(value.score)) {
          return null;
        }
        return { id, score: Math.round(value.score), band: value.band };
      } catch {
        // Fail-soft per ring — a transient engine error drops the ring,
        // never the snapshot.
        return null;
      }
    }),
  );
  return resolved.filter((r): r is DashboardScoreRing => r !== null);
}
