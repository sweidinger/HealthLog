/**
 * Google Health exercise-session sync (v1.27.0).
 *
 * Reads exercise sessions from the `activity_and_fitness.readonly` Restricted
 * bundle and upserts each into the `Workout` table as `source = GOOGLE_HEALTH`,
 * keyed on `(userId, source, externalId)` so a re-fetch overwrites in place.
 *
 * A Google Health run and the same run via Apple Health (or WHOOP) stay distinct
 * `Workout` rows (different `source`); the read-time `pickCanonicalWorkoutRows`
 * picker collapses the cross-source twin at read time per the user's source
 * ladder. There is no ingest-time collapse for a server-owned source pair.
 *
 * A per-data-class 403 soft-skips the resource — the activity/fitness bundle is
 * granted independently in the Google consent flow.
 */
import {
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE,
  GOOGLE_HEALTH_DATA_TYPES,
  fetchDataPoints,
  mapWorkout,
  type GoogleHealthMappedWorkout,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  type GoogleHealthResourceSyncOptions,
} from "./sync";
import { prisma } from "@/lib/db";
import { annotate, getEvent } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export async function syncUserWorkout(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // Session start/end can arrive offset-less; anchor them against the user's
  // stored zone rather than the process zone. The zone also shapes the
  // incremental filter: exercise sessions filter on
  // `exercise.interval.civil_start_time` with an offset-less civil bound, which
  // must be the watermark's wall clock in the USER'S zone.
  const tz = await resolveUserTimezone(userId);

  // Cycle-wide watermark snapshotted once by `syncUserGoogleHealth`; undefined
  // on a full/backfill run.
  const start = opts.start;

  let points: Record<string, unknown>[];
  try {
    points = await fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.exercise,
      tokenInfo.accessToken,
      "fetchExercise",
      { start, pageSize: GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE, tz },
    );
  } catch (err) {
    return handleCollectionFetchError("fetchExercise", userId, err);
  }

  let imported = 0;
  for (const point of points) {
    const w: GoogleHealthMappedWorkout | null = mapWorkout(point, tz);
    if (!w) continue; // no usable time span — not a workout

    try {
      await prisma.workout.upsert({
        where: {
          userId_source_externalId: {
            userId,
            source: "GOOGLE_HEALTH",
            externalId: w.externalId,
          },
        },
        create: {
          userId,
          source: "GOOGLE_HEALTH",
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
      getEvent()?.addWarning(`google-health: failed to upsert workout: ${err}`);
    }
  }

  // `markSynced` is owned by the orchestrator (`syncUserGoogleHealth`).
  annotate({
    action: { name: "googleHealth.workout.sync", details: { imported } },
  });
  return imported;
}
