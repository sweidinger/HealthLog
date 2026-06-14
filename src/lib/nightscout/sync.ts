/**
 * Nightscout CGM sync (v1.17.0).
 *
 * Pulls the most recent SGV entries from the user's self-hosted Nightscout
 * instance and writes each as a `BLOOD_GLUCOSE` mg/dL Measurement tagged
 * `source = NIGHTSCOUT`. This is the CGM density that makes the clinical
 * glucose panel (TIR / GMI) real — a continuous stream rather than the manual
 * spot readings.
 *
 * Idempotency: each row's `externalId` is derived from Nightscout's `_id` (or
 * the reading's epoch ms), and the write is FIRST-WRITE-WINS — a CGM sample is
 * an immutable canonical reading, so the `(userId, type, source, externalId)`
 * unique collapses a re-sync onto the existing row and the `update` branch is a
 * no-op (no value overwrite). This mirrors the Apple Health immutable-sample
 * contract, not the WHOOP re-score overwrite.
 *
 * Status bookkeeping rides the shared integration ledger (`nightscout` key): a
 * clean pass stamps `recordSyncSuccess`; an unreachable instance / wrong token
 * records a classified `recordSyncFailure` and rethrows so the cohort runner
 * can warn-and-continue.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { getEvent } from "@/lib/logging/context";
import {
  recordSyncFailure,
  recordSyncSuccess,
  type FailureKind,
} from "@/lib/integrations/status";
import {
  collapseToTypeDayKeys,
  recomputeBucketsForMeasurement,
} from "@/lib/rollups/measurement-rollups";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import {
  fetchSgvEntries,
  mapSgvEntryToMeasurement,
  NightscoutApiError,
  type ParsedSgvEntry,
} from "./client";
import { getUserNightscoutCredentials } from "./credentials";

/**
 * How many recent SGV entries to pull per sync tick. A CGM emits one reading
 * every ~5 min (≈288/day); 576 covers ~48 h of catch-up so a missed hourly
 * tick (or a brief outage) still backfills on the next run without paging the
 * full instance. The far-history backfill walks larger windows separately.
 */
export const NIGHTSCOUT_SYNC_COUNT = 576;

/**
 * Redact the Nightscout auth secret from an error message before it reaches the
 * integration ledger / the `/api/nightscout/status` response.
 *
 * The entries URL carries the access token as a `?token=<secret>` query param
 * (and a classic instance may carry `api-secret`). A `SafeFetchError` embeds the
 * full target URL verbatim in its message — a private-host refusal, a timeout,
 * or a network failure would otherwise persist the token into `lastError` and
 * echo it back through the status endpoint. Rewrite any URL in the message so
 * the secret-bearing params read `=REDACTED`; everything else is preserved so
 * the operator still sees a useful diagnostic.
 */
export function redactNightscoutSecret(message: string): string {
  // Match `token=...` / `api-secret=...` up to the next param / whitespace /
  // quote boundary. Case-insensitive on the key; the value is whatever a URL
  // query value can hold short of a delimiter.
  return message.replace(
    /\b(token|api-secret)=[^\s&"']+/gi,
    "$1=REDACTED",
  );
}

/** Map a Nightscout HTTP status / network error onto the shared ledger kind. */
export function classifyNightscoutFailure(err: unknown): FailureKind {
  if (err instanceof NightscoutApiError && err.status != null) {
    // Wrong / missing token, or a token whose role can't read SGV.
    if (err.status === 401 || err.status === 403) return "reauth_required";
    // 4xx other than auth = a contract / config problem worth surfacing.
    if (err.status >= 400 && err.status < 500) return "persistent";
  }
  // 5xx, timeout, DNS, connection refused — retry on the next tick.
  return "transient";
}

/**
 * Sync one user's recent SGV entries. Returns the count of rows written
 * (newly inserted or re-confirmed). A user with no configured instance is a
 * clean no-op (returns 0, touches no status row).
 */
export async function syncUserNightscout(
  userId: string,
  opts: { count?: number } = {},
): Promise<number> {
  const creds = await getUserNightscoutCredentials(userId);
  if (!creds) return 0;

  let entries: ParsedSgvEntry[];
  try {
    entries = await fetchSgvEntries({
      baseUrl: creds.baseUrl,
      token: creds.token,
      count: opts.count ?? NIGHTSCOUT_SYNC_COUNT,
      allowPrivateHost: creds.allowPrivateHost,
    });
  } catch (err) {
    await recordSyncFailure({
      userId,
      integration: "nightscout",
      kind: classifyNightscoutFailure(err),
      message: redactNightscoutSecret(
        err instanceof Error ? err.message : String(err),
      ),
      errorCode:
        err instanceof NightscoutApiError && err.status != null
          ? String(err.status)
          : undefined,
    });
    throw err;
  }

  const imported = await upsertNightscoutEntries(userId, entries);

  await recordSyncSuccess(userId, "nightscout");
  return imported;
}

/**
 * Insert each SGV entry as an immutable BLOOD_GLUCOSE mg/dL row, then fold the
 * rollup tier + invalidate status-insight caches once at the end (mirrors the
 * Withings / WHOOP sync tail). First-write-wins: the `update` branch is empty
 * so a re-sync of the same reading is a no-op rather than a rewrite. Best-effort
 * on the per-row write + the rollup fold — one bad row never aborts the pass.
 */
export async function upsertNightscoutEntries(
  userId: string,
  entries: ParsedSgvEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;

  const type = "BLOOD_GLUCOSE" as MeasurementType;
  let imported = 0;
  const touched: Array<{ type: MeasurementType; measuredAt: Date }> = [];

  for (const entry of entries) {
    const mapped = mapSgvEntryToMeasurement(entry);
    try {
      await prisma.measurement.upsert({
        where: {
          userId_type_source_externalId: {
            userId,
            type,
            source: "NIGHTSCOUT",
            externalId: mapped.externalId,
          },
        },
        create: {
          userId,
          type,
          source: "NIGHTSCOUT",
          value: mapped.value,
          unit: mapped.unit,
          measuredAt: mapped.measuredAt,
          externalId: mapped.externalId,
        },
        // First-write-wins: a CGM sample is immutable, so a re-sync of the
        // same reading must not rewrite the stored value or measuredAt.
        update: {},
      });
      touched.push({ type, measuredAt: mapped.measuredAt });
      imported++;
    } catch (err) {
      getEvent()?.addWarning(
        `nightscout: failed to upsert measurement: ${err}`,
      );
    }
  }

  try {
    const keys = collapseToTypeDayKeys(touched);
    for (const k of keys) {
      await recomputeBucketsForMeasurement(userId, k.type, k.measuredAt);
    }
    invalidateStatusInsightsForTypes(
      userId,
      keys.map((k) => k.type),
    ).catch((err) => {
      getEvent()?.addWarning(
        `nightscout: status-insight invalidate failed for ${userId}: ${err}`,
      );
    });
  } catch (err) {
    getEvent()?.addWarning(
      `nightscout: rollup fold failed for ${userId}: ${err}`,
    );
  }

  return imported;
}
