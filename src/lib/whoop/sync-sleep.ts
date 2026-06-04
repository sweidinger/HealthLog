/**
 * WHOOP sleep sync. Fetches sleep activity records since the incremental
 * cursor (24 h overlap for the re-score lag), maps each scored record via
 * `mapSleep` (per-stage SLEEP_DURATION rows, SLEEP_NEED, the SLEEP_*
 * percentages, RESPIRATORY_RATE), and upserts as `source = WHOOP`.
 *
 * Per-stage rows carry the `sleepStage` axis so the five stage rows for one
 * night stay distinct under the dedup key. externalId = `<sleep_id>:<fieldTag>`.
 */
import { fetchSleeps, mapSleep } from "./client";
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

export async function syncUserSleep(
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

  let records: Awaited<ReturnType<typeof fetchSleeps>>;
  try {
    records = await fetchSleeps(tokenInfo.accessToken, { start });
  } catch (err) {
    // A per-resource 403 soft-skips this data class rather than parking the
    // whole connection — sibling resources still sync.
    if (isCollectionForbidden(err)) {
      getEvent()?.addWarning(
        `whoop sleep sync skipped for ${userId}: collection 403 (soft-skip)`,
      );
      return 0;
    }
    await recordWhoopSyncFailure(userId, err);
    throw err;
  }

  const readings: WhoopMeasurementUpsert[] = [];
  for (const s of records) {
    for (const m of mapSleep(s)) {
      readings.push({
        type: m.type,
        value: m.value,
        unit: m.unit,
        measuredAt: m.measuredAt,
        externalId: `${s.id}:${m.fieldTag}`,
        sleepStage: m.sleepStage ?? null,
      });
    }
  }

  const imported = await upsertWhoopMeasurements(userId, readings);
  await markSynced(userId);
  return imported;
}
