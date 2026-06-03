/**
 * WHOOP workout sync. Fetches workout activities since the incremental cursor
 * and upserts each into the `Workout` table as `source = WHOOP`, keyed on
 * `(userId, source, externalId)` so a re-score overwrites in place.
 *
 * Per-workout strain (`WORKOUT_STRAIN`), HR-zone durations, `percent_recorded`,
 * and altitude live in `Workout.metadata` (tied to the workout row) rather than
 * as free-floating Measurements — a phantom strain Measurement would survive
 * if the workout were later de-duped away by the read-time picker. Energy is
 * converted kJ→kcal via `KJ_TO_KCAL` for `totalEnergyKcal`.
 *
 * A WHOOP run and the same run via Apple Health remain two distinct `Workout`
 * rows (different `source`); the read-time `pickCanonicalWorkoutRows` picker
 * (E-slice, W6) collapses the cross-source twin at read time.
 */
import { fetchWorkouts, KJ_TO_KCAL } from "./client";
import {
  getValidToken,
  incrementalStart,
  markSynced,
  recordWhoopSyncFailure,
} from "./sync";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import type { Prisma } from "@/generated/prisma/client";

/** WHOOP reports a numeric `sport_id`; fall back to a generic label. */
function sportLabel(sportId: number | undefined, sportName?: string): string {
  if (sportName) return sportName;
  if (typeof sportId === "number") return `whoop_sport_${sportId}`;
  return "workout";
}

export async function syncUserWorkout(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const connection = await prisma.whoopConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) return 0;

  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
  });

  let records: Awaited<ReturnType<typeof fetchWorkouts>>;
  try {
    records = await fetchWorkouts(tokenInfo.accessToken, { start });
  } catch (err) {
    await recordWhoopSyncFailure(userId, err);
    throw err;
  }

  let imported = 0;
  for (const w of records) {
    if (!w.score) continue; // unscored workout — nothing to store yet
    const startedAt = new Date(w.start);
    const endedAt = new Date(w.end);
    const durationSec = Math.max(
      0,
      Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
    );
    const energyKcal =
      typeof w.score.kilojoule === "number"
        ? Math.round(w.score.kilojoule * KJ_TO_KCAL)
        : null;

    const metadata: Prisma.InputJsonValue = {
      whoopWorkoutStrain: w.score.strain,
      percentRecorded: w.score.percent_recorded,
      ...(w.score.altitude_gain_meter != null
        ? { altitudeGainMeter: w.score.altitude_gain_meter }
        : {}),
      ...(w.score.altitude_change_meter != null
        ? { altitudeChangeMeter: w.score.altitude_change_meter }
        : {}),
      ...(w.score.zone_durations
        ? { zoneDurations: w.score.zone_durations }
        : {}),
    };

    try {
      await prisma.workout.upsert({
        where: {
          userId_source_externalId: {
            userId,
            source: "WHOOP",
            externalId: w.id,
          },
        },
        create: {
          userId,
          source: "WHOOP",
          externalId: w.id,
          sportType: sportLabel(w.sport_id, w.sport_name),
          startedAt,
          endedAt,
          durationSec,
          totalEnergyKcal: energyKcal,
          totalDistanceM: w.score.distance_meter ?? null,
          avgHeartRate: w.score.average_heart_rate ?? null,
          maxHeartRate: w.score.max_heart_rate ?? null,
          elevationM: w.score.altitude_gain_meter ?? null,
          metadata,
        },
        update: {
          sportType: sportLabel(w.sport_id, w.sport_name),
          startedAt,
          endedAt,
          durationSec,
          totalEnergyKcal: energyKcal,
          totalDistanceM: w.score.distance_meter ?? null,
          avgHeartRate: w.score.average_heart_rate ?? null,
          maxHeartRate: w.score.max_heart_rate ?? null,
          elevationM: w.score.altitude_gain_meter ?? null,
          metadata,
        },
      });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(`WHOOP: failed to upsert workout: ${err}`);
    }
  }

  await markSynced(userId);
  return imported;
}
