/**
 * Fitbit / Google Health "health metrics & measurements" bundle sync (v1.12.0).
 *
 * Reads the launch metric data types from the
 * `health_metrics_and_measurements.readonly` Restricted bundle and upserts each
 * mapped reading as `source = FITBIT`:
 *
 *   - weight                 → WEIGHT
 *   - body-fat               → BODY_FAT
 *   - daily-oxygen-saturation→ OXYGEN_SATURATION
 *   - daily-HRV              → HEART_RATE_VARIABILITY (SDNN slot; see mapper)
 *   - daily-resting-HR       → RESTING_HEART_RATE
 *   - daily-respiratory-rate → RESPIRATORY_RATE
 *   - heart-rate (intraday)  → PULSE
 *   - daily sleep-temp deriv.→ WRIST_TEMPERATURE
 *   - height                 → User.heightCm (profile seed, NOT a Measurement)
 *
 * Each data point yields at most one Measurement row, disambiguated by the
 * per-point anchor + field-tag in the externalId (`<anchor>:<fieldTag>`) so a
 * re-fetch of the same window overwrites in place rather than duplicating.
 *
 * A per-data-class 403 soft-skips THAT class (returns 0, leaves the connection
 * connected) rather than parking the whole integration — the six Restricted
 * bundles can be granted independently in the Google consent flow.
 *
 * Activity / sleep / workout land in W5; this is the first (and W3-only) resource.
 */
import {
  FITBIT_DATA_TYPES,
  type FitbitDataType,
  type FitbitMappedMeasurement,
  fetchDataPoints,
  mapBodyFat,
  mapHeartRate,
  mapHeartRateVariability,
  mapHeightCm,
  mapOxygenSaturation,
  mapRespiratoryRate,
  mapRestingHeartRate,
  mapSleepTemperature,
  mapWeight,
} from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  upsertFitbitMeasurements,
  type FitbitMeasurementUpsert,
  type FitbitResourceSyncOptions,
} from "./sync";
import { getEvent } from "@/lib/logging/context";
import { prisma } from "@/lib/db";

/** One mappable metric: its data-type encoding + the per-point mapper + a verb. */
interface MetricResource {
  dataType: FitbitDataType;
  map: (point: Record<string, unknown>) => FitbitMappedMeasurement[];
  verb: string;
}

/** The launch metric resources (Measurement-producing). Height is handled separately. */
const METRIC_RESOURCES: MetricResource[] = [
  { dataType: FITBIT_DATA_TYPES.weight, map: mapWeight, verb: "fetchWeight" },
  { dataType: FITBIT_DATA_TYPES.bodyFat, map: mapBodyFat, verb: "fetchBodyFat" },
  {
    dataType: FITBIT_DATA_TYPES.oxygenSaturation,
    map: mapOxygenSaturation,
    verb: "fetchSpo2",
  },
  {
    dataType: FITBIT_DATA_TYPES.heartRateVariability,
    map: mapHeartRateVariability,
    verb: "fetchHrv",
  },
  {
    dataType: FITBIT_DATA_TYPES.restingHeartRate,
    map: mapRestingHeartRate,
    verb: "fetchRhr",
  },
  {
    dataType: FITBIT_DATA_TYPES.respiratoryRate,
    map: mapRespiratoryRate,
    verb: "fetchRespiratoryRate",
  },
  {
    dataType: FITBIT_DATA_TYPES.heartRate,
    map: mapHeartRate,
    verb: "fetchHeartRate",
  },
  {
    dataType: FITBIT_DATA_TYPES.sleepTemperature,
    map: mapSleepTemperature,
    verb: "fetchSleepTemperature",
  },
];

export async function syncUserMetrics(
  userId: string,
  opts: FitbitResourceSyncOptions = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  // The incremental lower bound is the cycle-wide watermark snapshotted once by
  // `syncUserFitbit` — never re-read here, so a sibling resource's stamp can't
  // shrink this one's window. Undefined on a full/backfill run.
  const start = opts.start;

  let imported = 0;

  // Each metric data type is fetched + mapped independently so a per-class 403
  // soft-skips only that class.
  for (const resource of METRIC_RESOURCES) {
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

    const readings: FitbitMeasurementUpsert[] = [];
    for (const point of points) {
      for (const m of resource.map(point)) {
        readings.push({
          type: m.type,
          value: m.value,
          unit: m.unit,
          measuredAt: m.measuredAt,
          externalId: m.fieldTag,
        });
      }
    }
    imported += (
      await upsertFitbitMeasurements(userId, readings, {
        deferRollup: opts.deferRollup,
      })
    ).imported;
  }

  // Height → User.heightCm, only when the user has no height yet. Never mint a
  // Measurement; never overwrite a user-set value. Mirrors WHOOP's mapBody seed.
  try {
    let heightPoints: Record<string, unknown>[];
    try {
      heightPoints = await fetchDataPoints(
        FITBIT_DATA_TYPES.height,
        tokenInfo.accessToken,
        "fetchHeight",
        { start },
      );
    } catch (err) {
      heightPoints = [];
      await handleCollectionFetchError("fetchHeight", userId, err);
    }

    // Latest non-null parsed height wins (the points are time-ordered ascending).
    let heightCm: number | null = null;
    for (const point of heightPoints) {
      const cm = mapHeightCm(point);
      if (cm !== null) heightCm = cm;
    }
    if (heightCm !== null) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { heightCm: true },
      });
      if (user && user.heightCm === null) {
        await prisma.user.update({
          where: { id: userId },
          data: { heightCm },
        });
      }
    }
  } catch (err) {
    getEvent()?.addWarning(
      `fitbit: failed to seed heightCm for ${userId}: ${err}`,
    );
  }

  // `markSynced` is owned by the orchestrator (`syncUserFitbit`), stamped once
  // at the end of the cycle — never here, so the watermark can't move mid-cycle.
  return imported;
}
