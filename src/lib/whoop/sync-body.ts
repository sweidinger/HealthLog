/**
 * WHOOP body-measurement sync. The body endpoint is a single object (not a
 * paginated collection): one self-reported profile snapshot carrying weight,
 * max heart rate, and height. It fans out to three destinations:
 *
 *   - `weight_kilogram` → a `WEIGHT` `Measurement` (source = WHOOP) keyed on a
 *     STABLE externalId (`whoop:body:weight`). Because the profile weight is a
 *     single value rather than a time series, the externalId never carries the
 *     fetch time — a re-sync overwrites the same row in place rather than
 *     accumulating a duplicate per poll. `measuredAt` is the fetch time so the
 *     read-time source-priority picker (a real scale outranks WHOOP) and the
 *     trend view treat it as "as of now".
 *   - `max_heart_rate` → `WhoopConnection.maxHeartRate` (a profile constant,
 *     not a time series — lives on the connection row, not a `Measurement`).
 *   - `height_meter` → `User.heightCm`, converted m→cm, written ONLY when the
 *     user has no height yet. A user-set height is never overwritten, and
 *     height is never minted as a `Measurement`.
 *
 * Every write is field-by-field and idempotent across reruns. A per-resource
 * 403 soft-skips this data class (returns 0, leaves the connection connected)
 * rather than parking the whole integration — see `isCollectionForbidden`.
 */
import { fetchBodyMeasurement, mapBody } from "./client";
import {
  getValidToken,
  handleCollectionFetchError,
  markSynced,
  upsertWhoopMeasurements,
  type WhoopMeasurementUpsert,
} from "./sync";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

/** Stable externalId for the single WHOOP profile weight row (overwrite). */
export const WHOOP_BODY_WEIGHT_EXTERNAL_ID = "whoop:body:weight";

/**
 * The body measurement is a single profile snapshot — there is no incremental
 * window to seek, so this sync ignores `fullSync` (the incremental vs backfill
 * distinction the collection syncs honour). The `opts` parameter is accepted to
 * keep the `syncUserWhoop` loop signature uniform.
 */
export async function syncUserBody(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  void opts;

  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  let body: Awaited<ReturnType<typeof fetchBodyMeasurement>>;
  try {
    body = await fetchBodyMeasurement(tokenInfo.accessToken);
  } catch (err) {
    return handleCollectionFetchError("body", userId, err);
  }

  const mapped = mapBody(body);
  const measuredAt = new Date();

  // Weight → a single overwrite-in-place WEIGHT Measurement.
  let imported = 0;
  if (mapped.weightKg !== null) {
    const reading: WhoopMeasurementUpsert = {
      type: "WEIGHT",
      value: mapped.weightKg,
      unit: "kg",
      measuredAt,
      externalId: WHOOP_BODY_WEIGHT_EXTERNAL_ID,
    };
    imported += await upsertWhoopMeasurements(userId, [reading]);
  }

  // Max heart rate → WhoopConnection.maxHeartRate (profile constant).
  if (mapped.maxHeartRate !== null) {
    try {
      await prisma.whoopConnection.update({
        where: { userId },
        data: { maxHeartRate: mapped.maxHeartRate },
      });
    } catch (err) {
      getEvent()?.addWarning(
        `whoop: failed to persist maxHeartRate for ${userId}: ${err}`,
      );
    }
  }

  // Height → User.heightCm, only when the user has no height yet. Never
  // overwrite a user-set value; never mint a Measurement.
  if (mapped.heightCm !== null) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { heightCm: true },
      });
      if (user && user.heightCm === null) {
        await prisma.user.update({
          where: { id: userId },
          data: { heightCm: mapped.heightCm },
        });
      }
    } catch (err) {
      getEvent()?.addWarning(
        `whoop: failed to seed heightCm for ${userId}: ${err}`,
      );
    }
  }

  await markSynced(userId);
  return imported;
}
