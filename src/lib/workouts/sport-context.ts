/**
 * Own-history comparison for a single sport.
 *
 * The user's own recent average for a sport, rendered as one muted
 * comparison line on the workout-detail page and as the comparison leg of
 * the Coach's per-workout evidence block. Cross-source twins are collapsed
 * through `pickCanonicalWorkoutRows()` first so a run recorded by two
 * paired watches counts once. Comparisons are to the user's own history
 * only (non-diagnostic standard) — never to a population band.
 *
 * Lifted out of `GET /api/workouts/{id}` so the Coach's workout evidence
 * block reads the SAME figures the detail page shows. Two surfaces quoting
 * different averages for one sport is the drift this move removes.
 */
import { prisma } from "@/lib/db";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";

/** Own-history lookback for the sport-average comparison line. */
export const SPORT_CONTEXT_LOOKBACK_DAYS = 180;
/** Slim-row cap for the sport-average read. */
export const SPORT_CONTEXT_MAX_ROWS = 500;

export interface WorkoutSportContext {
  count: number;
  avgDurationSec: number;
  avgDistanceM: number | null;
  avgAvgHr: number | null;
}

export async function buildSportContext(
  userId: string,
  sportType: string,
  sourcePriorityJson: unknown,
): Promise<WorkoutSportContext | null> {
  const since = new Date(
    Date.now() - SPORT_CONTEXT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await prisma.workout.findMany({
    // `userId` stays in the where clause — the universal tenancy narrow.
    where: { userId, sportType, startedAt: { gte: since } },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    take: SPORT_CONTEXT_MAX_ROWS,
    select: {
      id: true,
      source: true,
      startedAt: true,
      sportType: true,
      durationSec: true,
      totalDistanceM: true,
      avgHeartRate: true,
    },
  });
  const canonical = pickCanonicalWorkoutRows(rows, sourcePriorityJson);
  if (canonical.length === 0) return null;

  let durationSum = 0;
  let distanceSum = 0;
  let distanceCount = 0;
  let hrSum = 0;
  let hrCount = 0;
  for (const r of canonical) {
    durationSum += r.durationSec;
    if (r.totalDistanceM != null) {
      distanceSum += r.totalDistanceM;
      distanceCount += 1;
    }
    if (r.avgHeartRate != null) {
      hrSum += r.avgHeartRate;
      hrCount += 1;
    }
  }
  return {
    count: canonical.length,
    avgDurationSec: Math.round(durationSum / canonical.length),
    avgDistanceM: distanceCount > 0 ? distanceSum / distanceCount : null,
    avgAvgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
  };
}
