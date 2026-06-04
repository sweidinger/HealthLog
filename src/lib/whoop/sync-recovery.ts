/**
 * WHOOP recovery sync. Fetches recovery records since the incremental cursor
 * (24 h overlap to absorb WHOOP's after-the-fact re-scoring), maps each scored
 * record via `mapRecovery`, and upserts the readings as `source = WHOOP`.
 *
 * Each recovery object yields several Measurement rows (recovery-score, RMSSD,
 * RHR, SpO2, skin-temp), disambiguated by the field-tag in the externalId:
 * `<sleep_id>:<fieldTag>`. The recovery record is keyed off its associated
 * sleep UUID (v2 recovery carries `sleep_id`, not a stable recovery id) so the
 * externalId is stable across re-scores.
 */
import { fetchRecoveries, mapRecovery } from "./client";
import {
  getValidToken,
  incrementalStart,
  isCollectionForbidden,
  markSynced,
  recordWhoopSyncFailure,
  upsertWhoopMeasurements,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  type WhoopMeasurementUpsert,
} from "./sync";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

export async function syncUserRecovery(
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
    overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  });

  let records: Awaited<ReturnType<typeof fetchRecoveries>>;
  try {
    records = await fetchRecoveries(tokenInfo.accessToken, { start });
  } catch (err) {
    // A per-resource 403 soft-skips this data class rather than parking the
    // whole connection — sibling resources still sync.
    if (isCollectionForbidden(err)) {
      getEvent()?.addWarning(
        `whoop recovery sync skipped for ${userId}: collection 403 (soft-skip)`,
      );
      return 0;
    }
    await recordWhoopSyncFailure(userId, err);
    throw err;
  }

  const readings: WhoopMeasurementUpsert[] = [];
  for (const r of records) {
    // `sleep_id` is the stable v2 anchor for the recovery record.
    const anchor = r.sleep_id;
    for (const m of mapRecovery(r)) {
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: `${anchor}:${m.fieldTag}`,
      });
    }
  }

  const imported = await upsertWhoopMeasurements(userId, readings);
  await markSynced(userId);
  return imported;
}
