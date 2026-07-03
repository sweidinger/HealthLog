/**
 * Google Health activity-bundle sync (v1.27.0).
 *
 * Reads the daily cumulative-activity data types from the
 * `activity_and_fitness.readonly` Restricted bundle and upserts each mapped
 * daily total as `source = GOOGLE_HEALTH`:
 *
 *   - steps               → ACTIVITY_STEPS            (count)
 *   - distance            → WALKING_RUNNING_DISTANCE  (metres)
 *   - active-energy-burned→ ACTIVE_ENERGY_BURNED      (kcal — ACTIVE portion only)
 *   - floors              → FLIGHTS_CLIMBED           (count)
 *   - vo2-max             → VO2_MAX                    (mL/(kg·min); daily latest-wins)
 *
 * These are per-day summaries (one value per calendar day). The externalId is
 * minted with the `stats:` daily-total prefix — `stats:<fieldTag>:<YYYY-MM-DD>`
 * — so a re-fetched day OVERWRITES the existing row rather than minting a
 * duplicate, matching the Apple-Health `stats:<HK>:<YYYY-MM-DD>` overwrite
 * contract. A day of rest legitimately records 0 steps / 0 floors / 0 active
 * kcal, so the cumulative mappers preserve a zero; VO2 max stays strictly
 * positive.
 *
 * A per-data-class 403 soft-skips THAT class (returns 0, leaves the connection
 * connected) — the Restricted bundles are granted independently.
 */
import {
  GOOGLE_HEALTH_DATA_TYPES,
  type GoogleHealthDataType,
  type GoogleHealthMappedMeasurement,
  fetchDataPoints,
  mapActiveEnergy,
  mapDistance,
  mapFloors,
  mapSteps,
  mapVo2Max,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  upsertGoogleHealthMeasurements,
  type GoogleHealthMeasurementUpsert,
  type GoogleHealthResourceSyncOptions,
} from "./sync";
import { annotate } from "@/lib/logging/context";

/** One mappable activity metric: its data-type encoding + the mapper + a verb. */
interface ActivityResource {
  dataType: GoogleHealthDataType;
  map: (point: Record<string, unknown>) => GoogleHealthMappedMeasurement[];
  verb: string;
}

const ACTIVITY_RESOURCES: ActivityResource[] = [
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.steps,
    map: mapSteps,
    verb: "fetchSteps",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.distance,
    map: mapDistance,
    verb: "fetchDistance",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.activeEnergy,
    map: mapActiveEnergy,
    verb: "fetchActiveEnergy",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.floors,
    map: mapFloors,
    verb: "fetchFloors",
  },
  {
    dataType: GOOGLE_HEALTH_DATA_TYPES.vo2Max,
    map: mapVo2Max,
    verb: "fetchVo2Max",
  },
];

/**
 * Assemble the stored externalId for a mapped activity reading. A cumulative
 * daily metric carries the `cumulativeDaily` flag from its mapper — its
 * externalId gets the `stats:` daily-total prefix so a re-fetched day overwrites
 * in place (the mapper's `fieldTag` is already the `<tag>:<YYYY-MM-DD>` form).
 */
function externalIdFor(m: GoogleHealthMappedMeasurement): string {
  return m.cumulativeDaily ? `stats:${m.fieldTag}` : m.fieldTag;
}

export async function syncUserActivity(
  userId: string,
  opts: GoogleHealthResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // Cycle-wide watermark snapshotted once by `syncUserGoogleHealth`; undefined
  // on a full/backfill run.
  const start = opts.start;

  let imported = 0;
  for (const resource of ACTIVITY_RESOURCES) {
    let points: Record<string, unknown>[];
    try {
      points = await fetchDataPoints(
        resource.dataType,
        tokenInfo.accessToken,
        resource.verb,
        { start },
      );
    } catch (err) {
      imported += await handleCollectionFetchError(resource.verb, userId, err);
      continue;
    }

    const readings: GoogleHealthMeasurementUpsert[] = [];
    for (const point of points) {
      for (const m of resource.map(point)) {
        readings.push({
          type: m.type,
          value: m.value,
          unit: m.unit,
          measuredAt: m.measuredAt,
          externalId: externalIdFor(m),
        });
      }
    }
    imported += (
      await upsertGoogleHealthMeasurements(userId, readings, {
        deferRollup: opts.deferRollup,
      })
    ).imported;
  }

  // `markSynced` is owned by the orchestrator (`syncUserGoogleHealth`).
  annotate({
    action: { name: "googleHealth.activity.sync", details: { imported } },
  });
  return imported;
}
