/**
 * Google Health sleep-bundle sync (v1.27.0).
 *
 * Reads sleep sessions from the `sleep.readonly` Restricted bundle and maps each
 * into per-SEGMENT `SLEEP_DURATION` rows via `mapSleepSession` (one row per stage
 * segment; `measuredAt = that segment's END` instant; harmonised onto the shared
 * `SleepStage` enum IN_BED/AWAKE/ASLEEP/REM/CORE/DEEP that the night-total +
 * hypnogram readers already consume for WHOOP / Apple). Google carries a real
 * per-segment series, so the rows lay each block at its true clock time (a
 * MEASURED timeline, not reconstructed). Upserts as `source = GOOGLE_HEALTH`.
 *
 * Each segment carries the `sleepStage` axis and an indexed fieldTag so the
 * several segments of one stage stay distinct under the
 * `(userId, type, source, externalId)` dedup key. externalId =
 * `<session-anchor>:sleep_<stage>:<i>` — a re-scored night overwrites in place.
 * A 24 h overlap covers Google's after-the-fact re-score.
 *
 * A per-data-class 403 soft-skips the resource — the sleep bundle is granted
 * independently of activity / metrics in the Google consent flow.
 */
import {
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE,
  GOOGLE_HEALTH_DATA_TYPES,
  fetchDataPoints,
  mapSleepSession,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  upsertGoogleHealthMeasurements,
  type GoogleHealthMeasurementUpsert,
  type GoogleHealthResourceSyncOptions,
} from "./sync";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export async function syncUserSleep(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // Sleep-segment timestamps can arrive offset-less; anchor them against the
  // user's stored zone so a near-midnight segment END lands on the correct
  // wake-day rather than being shifted by the process zone.
  const tz = await resolveUserTimezone(userId);

  // Cycle-wide watermark snapshotted once by `syncUserGoogleHealth`; undefined
  // on a full/backfill run.
  const start = opts.start;

  let points: Record<string, unknown>[];
  try {
    points = await fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.sleep,
      tokenInfo.accessToken,
      "fetchSleep",
      { start, pageSize: GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE },
    );
  } catch (err) {
    return handleCollectionFetchError("fetchSleep", userId, err);
  }

  const readings: GoogleHealthMeasurementUpsert[] = [];
  for (const point of points) {
    for (const m of mapSleepSession(point, tz)) {
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

  const imported = (
    await upsertGoogleHealthMeasurements(userId, readings, {
      deferRollup: opts.deferRollup,
    })
  ).imported;
  // `markSynced` is owned by the orchestrator (`syncUserGoogleHealth`).
  annotate({
    action: { name: "googleHealth.sleep.sync", details: { imported } },
  });
  return imported;
}
