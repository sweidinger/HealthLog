/**
 * WHOOP sleep sync. Fetches sleep activity records since the incremental
 * cursor (24 h overlap for the re-score lag), maps each scored record via
 * `mapSleep` (per-stage SLEEP_DURATION rows, SLEEP_NEED, the SLEEP_*
 * percentages, RESPIRATORY_RATE), and upserts as `source = WHOOP`.
 *
 * Per-stage rows carry the `sleepStage` axis so the five stage rows for one
 * night stay distinct under the dedup key. externalId = `<sleep_id>:<fieldTag>`.
 */
import { fetchSleeps, fetchSleepById, mapSleep } from "./client";
import {
  getValidToken,
  incrementalStart,
  handleCollectionFetchError,
  markResourceSynced,
  resolveResourceCursor,
  upsertWhoopMeasurements,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  type WhoopMeasurementUpsert,
} from "./sync";
import { prisma } from "@/lib/db";

export async function syncUserSleep(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  const connection = await prisma.whoopConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true, resourceCursors: true },
  });
  if (!connection) return 0;

  const start = incrementalStart(resolveResourceCursor(connection, "sleep"), {
    fullSync: opts.fullSync,
    overlapMs: WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
  });

  let records: Awaited<ReturnType<typeof fetchSleeps>>;
  try {
    records = await fetchSleeps(tokenInfo.accessToken, { start });
  } catch (err) {
    return handleCollectionFetchError("sleep", userId, err);
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
  await markResourceSynced(userId, "sleep");
  return imported;
}

/**
 * Webhook-driven targeted refresh: resolve ONE sleep activity by its uuid and
 * upsert its readings, instead of re-walking the whole collection. An unscored
 * / since-deleted record yields nothing. Does NOT advance the resource cursor
 * (a single-id refresh proves nothing about the records between the cursor and
 * now).
 */
export async function syncWhoopSleepById(
  userId: string,
  sleepId: string,
): Promise<number> {
  const tokenInfo = await getValidToken(userId);
  if (!tokenInfo) return 0;

  let record: Awaited<ReturnType<typeof fetchSleepById>>;
  try {
    record = await fetchSleepById(tokenInfo.accessToken, sleepId);
  } catch (err) {
    return handleCollectionFetchError("sleep", userId, err);
  }

  const readings: WhoopMeasurementUpsert[] = [];
  for (const m of mapSleep(record)) {
    readings.push({
      type: m.type,
      value: m.value,
      unit: m.unit,
      measuredAt: m.measuredAt,
      externalId: `${record.id}:${m.fieldTag}`,
      sleepStage: m.sleepStage ?? null,
    });
  }

  return upsertWhoopMeasurements(userId, readings);
}
