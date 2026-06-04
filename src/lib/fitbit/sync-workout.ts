/**
 * Fitbit / Google Health exercise-session sync (v1.12.0, W5).
 *
 * Reads exercise sessions from the `activity_and_fitness.readonly` Restricted
 * bundle and upserts each into the `Workout` table as `source = FITBIT`, keyed
 * on `(userId, source, externalId)` so a re-fetch overwrites in place.
 *
 * A Fitbit run and the same run via Apple Health (or WHOOP) stay distinct
 * `Workout` rows (different `source`); the read-time `pickCanonicalWorkoutRows`
 * picker collapses the cross-source twin at read time per the user's source
 * ladder (FITBIT is already in the default ladder, ranked just below WHOOP).
 * There is no ingest-time collapse for a server-owned source pair.
 *
 * A per-data-class 403 soft-skips the resource — the activity/fitness bundle is
 * granted independently in the Google consent flow.
 */
import {
  FITBIT_DATA_TYPES,
  fetchDataPoints,
  mapWorkout,
  type FitbitMappedWorkout,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  type FitbitResourceSyncOptions,
} from "./sync";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";

export async function syncUserWorkout(
  userId: string,
  opts: FitbitResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // Cycle-wide watermark snapshotted once by `syncUserFitbit`; undefined on a
  // full/backfill run.
  const start = opts.start;

  let points: Record<string, unknown>[];
  try {
    points = await fetchDataPoints(
      FITBIT_DATA_TYPES.exercise,
      tokenInfo.accessToken,
      "fetchExercise",
      { start, pageSize: 25 },
    );
  } catch (err) {
    return handleCollectionFetchError("fetchExercise", userId, err);
  }

  let imported = 0;
  for (const point of points) {
    const w: FitbitMappedWorkout | null = mapWorkout(point);
    if (!w) continue; // no usable time span — not a workout

    try {
      await prisma.workout.upsert({
        where: {
          userId_source_externalId: {
            userId,
            source: "FITBIT",
            externalId: w.externalId,
          },
        },
        create: {
          userId,
          source: "FITBIT",
          externalId: w.externalId,
          sportType: w.sportType,
          startedAt: w.startedAt,
          endedAt: w.endedAt,
          durationSec: w.durationSec,
          totalEnergyKcal: w.totalEnergyKcal,
          totalDistanceM: w.totalDistanceM,
          avgHeartRate: w.avgHeartRate,
          maxHeartRate: w.maxHeartRate,
          minHeartRate: w.minHeartRate,
        },
        update: {
          sportType: w.sportType,
          startedAt: w.startedAt,
          endedAt: w.endedAt,
          durationSec: w.durationSec,
          totalEnergyKcal: w.totalEnergyKcal,
          totalDistanceM: w.totalDistanceM,
          avgHeartRate: w.avgHeartRate,
          maxHeartRate: w.maxHeartRate,
          minHeartRate: w.minHeartRate,
        },
      });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`fitbit: failed to upsert workout: ${err}`);
    }
  }

  // `markSynced` is owned by the orchestrator (`syncUserFitbit`).
  annotate({ action: { name: "fitbit.workout.sync", details: { imported } } });
  return imported;
}
