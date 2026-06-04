/**
 * Fitbit / Google Health sleep-bundle sync (v1.12.0, W5).
 *
 * Reads sleep sessions from the `sleep.readonly` Restricted bundle and maps
 * each into per-stage `SLEEP_DURATION` rows via `mapSleepSession` (minutes per
 * stage; `measuredAt = the stage's END instant; harmonised onto the shared
 * `SleepStage` enum IN_BED/AWAKE/ASLEEP/REM/CORE/DEEP that the night-total +
 * hypnogram readers already consume for WHOOP / Apple). Upserts as
 * `source = FITBIT`.
 *
 * Per-stage rows carry the `sleepStage` axis so the (up to six) stage rows for
 * one night stay distinct under the `(userId, type, source, externalId)` dedup
 * key. externalId = `<session-anchor>:sleep_<stage>` — a re-scored night
 * overwrites in place. A 24 h overlap covers Google's after-the-fact re-score.
 *
 * A per-data-class 403 soft-skips the resource — the sleep bundle is granted
 * independently of activity / metrics in the Google consent flow.
 */
import { FITBIT_DATA_TYPES, fetchDataPoints, mapSleepSession } from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  incrementalStart,
  markSynced,
  upsertFitbitMeasurements,
  type FitbitMeasurementUpsert,
} from "./sync";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

export async function syncUserSleep(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const connection = await prisma.fitbitConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) return 0;

  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
  });

  let points: Record<string, unknown>[];
  try {
    points = await fetchDataPoints(
      FITBIT_DATA_TYPES.sleep,
      tokenInfo.accessToken,
      "fetchSleep",
      { start, pageSize: 25 },
    );
  } catch (err) {
    return handleCollectionFetchError("fetchSleep", userId, err);
  }

  const readings: FitbitMeasurementUpsert[] = [];
  for (const point of points) {
    for (const m of mapSleepSession(point)) {
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: m.fieldTag,
        sleepStage: m.sleepStage ?? null,
      });
    }
  }

  const imported = await upsertFitbitMeasurements(userId, readings);
  await markSynced(userId);
  annotate({ action: { name: "fitbit.sleep.sync", details: { imported } } });
  return imported;
}
