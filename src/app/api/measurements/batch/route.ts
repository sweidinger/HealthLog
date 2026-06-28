/**
 * `POST /api/measurements/batch` — Apple Health batch ingest.
 *
 * The iOS HealthLog app drains its HealthKit observer queue into this
 * endpoint. Each entry is a HealthKit sample dressed in a thin
 * envelope (identifier, value, unit, start/end dates, optional sleep
 * stage codepoint, opaque external id). The server maps each entry
 * through `mapAppleHealthEntry()`, inserts it as a `Measurement` row
 * with `source = APPLE_HEALTH`, and returns a per-entry status so the
 * client can advance its sync cursor accurately.
 *
 * Idempotency contract:
 *   - A single batch is dedupable end-to-end via `Idempotency-Key` —
 *     an HTTP-level retry replays the cached response.
 *   - Individual entries are dedupable via the
 *     `(user_id, type, source, external_id)` composite unique index —
 *     a partial-success retry, or two devices uploading the same
 *     HealthKit sample, surface as `duplicate` per entry instead of
 *     hard-failing the batch.
 *   - v1.5.0 issue #213 — entries whose `externalId` starts with
 *     `stats:` are aggregate rows the iOS HealthKit observer re-posts as
 *     the underlying window fills. Two granularities ride the same
 *     overwrite mechanism:
 *       · per-day cumulative totals — `stats:<HK>:<YYYY-MM-DD>` (Steps,
 *         Active Energy, Sleep Duration, Walking/Running Distance,
 *         Flights Climbed);
 *       · v1.19.0 (iOS #34) hourly heart-rate buckets —
 *         `stats:HKQuantityTypeIdentifierHeartRate:<bucket-start-hour>`
 *         carrying the hour's AVERAGE bpm as one PULSE row, so iOS stops
 *         uploading one row per raw HR sample.
 *     Both surface as `updated` (the row's value is overwritten) rather
 *     than `duplicate` (the new value dropped). Sample-class externalIds
 *     (every other prefix) keep the strict immutable `duplicate`
 *     contract.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import {
  mapAppleHealthEntry,
  isHourlyHeartRateStatsExternalId,
  targetsHourlyHeartRateBucket,
} from "@/lib/measurements/apple-health-mapping";
import {
  MEASURED_AT_TOLERANCE_MS,
  isMergeableSource,
  isSameReadingAcrossSource,
  oppositeMergeSource,
  type MergeCandidate,
} from "@/lib/measurements/cross-source-merge";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import {
  recomputeBucketsForMeasurement,
  collapseToTypeDayKeys,
} from "@/lib/rollups/measurement-rollups";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";

// v1.4.25 W16c — historical-backfill threshold for PR push
// suppression. A batch larger than this fires the detection job with
// `silent: true` so a multi-year Apple Health backfill writes records
// without spamming the user with hundreds of pushes. Tuned generously
// — a healthy daily-sync batch is typically well under 50 entries.
const PR_DETECTION_SILENT_THRESHOLD = 50;

const MAX_BATCH_ENTRIES = 500;

// Body-size ceiling backstopping the per-entry cap. A worst-case entry
// (max-length hkIdentifier + unit + externalId + two ISO dates + the
// numeric fields) serialises to well under 1 KB, so a legitimate
// 500-entry batch tops out a few hundred KB. 4 MB leaves an order of
// magnitude of headroom above any real batch while still rejecting a
// multi-megabyte payload before it reaches `JSON.parse` and the heap.
// The cap is a DoS ceiling, not a tight bound.
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// v1.4.25 W10 reconcile (security H-2): cap batch ingest at 60
// batches per user per minute. Healthy iOS sync drains its
// HealthKit observer queue in well under one batch per minute (the
// observer pattern coalesces), so 60/min × 500 entries/batch =
// 30 000 rows/min headroom — generous for legitimate use, and a
// hard stop for a leaked wildcard token trying to saturate the
// write pipeline.
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// v1.8.6 W6 — the set of `source` values this client-facing ingest
// route accepts. Deliberately narrower than the full `MeasurementSource`
// enum: `WITHINGS` and `IMPORT` are server-owned (the Withings webhook
// and the CSV importer mint those rows respectively), so letting an iOS
// client forge rows attributed to them would let an authenticated client
// pollute the per-source canonical picker with rows the server never saw
// from those integrations. The standalone iOS client only needs to tag
// its own adopt-on-pair backfill as `MANUAL` vs the default
// `APPLE_HEALTH` passthrough, so we accept exactly that pair.
const batchSourceEnum = z.enum(["APPLE_HEALTH", "MANUAL"]);

const batchEntrySchema = z.object({
  hkIdentifier: z.string().min(1).max(120),
  value: z.number().finite(),
  unit: z.string().min(1).max(60),
  startDate: z.iso.datetime({ offset: true }),
  endDate: z.iso.datetime({ offset: true }),
  sleepStage: z.number().int().min(0).max(20).optional(),
  // v1.10.0 — categorical events (WX-B). The integer `HKCategoryValue`
  // codepoint for an EVENT-class category sample (irregular-rhythm,
  // high/low-HR, walking-steadiness, breathing-disturbance). Carries the
  // device's own verdict / severity; resolved to a `rhythmClassification`
  // by `mapAppleHealthEntry`. Ignored for every non-event identifier.
  categoryValue: z.number().int().min(0).max(20).optional(),
  // v1.19.2 (iOS #34 extension) — per-bucket spread for the hourly
  // heart-rate bucket. `value` carries the hour's AVERAGE bpm; these carry
  // the hour's MIN / MAX so a client renders the intra-hour band without
  // re-uploading raw samples. Persisted ONLY on a well-formed
  // `stats:HKQuantityTypeIdentifierHeartRate:<hour>` row; ignored (stored
  // NULL) for every other entry. Optional + backward-compatible: a pre-W192
  // iOS build omits them and the bucket keeps the avg-only contract.
  valueMin: z.number().finite().optional(),
  valueMax: z.number().finite().optional(),
  externalId: z.string().min(1).max(120),
  externalSourceVersion: z.string().min(1).max(120).optional(),
  // v1.8.6 W6 — optional per-entry source tag. Defaults to
  // `APPLE_HEALTH` so every pre-W6 caller (web + current iOS) stays
  // byte-for-byte unchanged. The iOS standalone adopt-on-pair backfill
  // sends `MANUAL` for rows the user entered by hand on-device so they
  // are not mis-attributed to HealthKit. `source` is part of the
  // `(userId, type, source, externalId)` dedup key, so a `MANUAL` row
  // and an `APPLE_HEALTH` row sharing an externalId are distinct rows.
  source: batchSourceEnum.optional(),
  // v1.4.25 W8c — optional device-type tag. The iOS client maps the
  // `HKDevice.model` of each sample to one of the canonical device
  // classes (watch | band | ring | phone | scale | other | unknown).
  // Backward-compatible: every pre-W8c iOS build skips the field and
  // the row is stored with `deviceType = null`; the canonical picker
  // treats null as `unknown` and only uses it as a tiebreaker when a
  // ranked device-type coexists in the same daily bucket.
  deviceType: deviceTypeEnum.nullable().optional(),
});

const batchPayloadSchema = z.object({
  entries: z.array(batchEntrySchema).min(1),
});

type BatchEntry = z.infer<typeof batchEntrySchema>;

/**
 * Per-entry outcome the iOS client uses to advance its sync cursor.
 * `inserted` and `duplicate` both indicate the row landed (or was
 * already present), so the client can checkpoint past them. `updated`
 * is the per-day-aggregate overwrite path: when the iOS client re-posts
 * a `stats:*` cumulative row (Steps, Active Energy, Sleep Duration,
 * Walking/Running Distance, Flights Climbed — see issue #213) for a day
 * we already have, the server overwrites the row's `value` rather than
 * dropping the new payload as a duplicate. Sample-class rows (every
 * other HK metric) keep the strict `duplicate` semantics because each
 * sample is a canonical, immutable reading. `skipped` is the only case
 * where the client may want to surface a diagnostic — typically because
 * Apple introduced a new identifier the server doesn't know about yet.
 */
type EntryStatus = "inserted" | "updated" | "duplicate" | "skipped";

// v1.5.0 issue #213 — `stats:*` externalIds carry per-day cumulative
// totals that the iOS HealthKit observer re-posts as the day progresses.
// Treating those as immutable duplicates freezes the day's tile at the
// first-sync value. Sample-class externalIds (every other prefix) keep
// the strict insert-only contract.
const STATS_EXTERNAL_ID_PREFIX = "stats:";
function isStatsExternalId(externalId: string | null | undefined): boolean {
  return (
    typeof externalId === "string" &&
    externalId.startsWith(STATS_EXTERNAL_ID_PREFIX)
  );
}
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  // v1.4.25 W10 reconcile (security H-2): per-user rate limit. Without
  // it, a leaked wildcard iOS token can sustain unbounded writes
  // (500 rows/batch × N batches/sec) and degrade the database for
  // every other user on the host. 60 batches/min/user is generous
  // for healthy iOS sync and tight enough that a misbehaving client
  // bottoms out within a minute.
  const rl = await checkRateLimit(
    `measurements:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    annotate({
      action: { name: "measurement.batch.ingest" },
      meta: { outcome: "rate_limited" },
    });
    return apiError("Too many batch submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request, {
    maxBytes: MAX_BODY_BYTES,
  });
  if (jsonError) return jsonError;

  // Distinguish "too many entries" from "validation failed" so the
  // client surfaces a useful diagnostic. The cap stops a buggy client
  // from saturating the request pipeline; the iOS app paginates above
  // this threshold.
  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_BATCH_ENTRIES
  ) {
    return apiError(`Batch exceeds the ${MAX_BATCH_ENTRIES}-entry limit`, 422, {
      errorCode: "measurement.batch.too_large",
    });
  }

  const parsed = batchPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid batch", 422);
  }

  const { entries } = parsed.data;

  // First pass — map each inbound entry; record skipped entries.
  type Prepared = {
    index: number;
    entry: BatchEntry;
    row: Prisma.MeasurementCreateManyInput;
  };
  const prepared: Prepared[] = [];
  const results: EntryResult[] = new Array(entries.length);

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const mapped = mapAppleHealthEntry({
      hkIdentifier: entry.hkIdentifier,
      value: entry.value,
      unit: entry.unit,
      startDate: entry.startDate,
      endDate: entry.endDate,
      sleepStage: entry.sleepStage,
      categoryValue: entry.categoryValue,
      valueMin: entry.valueMin,
      valueMax: entry.valueMax,
    });

    if (!mapped) {
      results[index] = {
        index,
        status: "skipped",
        reason: "unmappable_identifier",
      };
      continue;
    }

    // Plausibility-range guard. We tolerate "out of plausible range"
    // by skipping rather than failing the batch — a single bogus
    // sensor reading shouldn't poison an otherwise clean ingest.
    const rangeError = validateMeasurementRange(mapped.type, mapped.value);
    if (rangeError !== null) {
      results[index] = {
        index,
        status: "skipped",
        reason: "value_out_of_range",
      };
      continue;
    }

    // v1.19.0 (iOS #34) — go-forward aggregated heart-rate wire
    // contract. A `stats:HKQuantityTypeIdentifierHeartRate:<hour>` row
    // is the hourly-average PULSE bucket; it rides the generic `stats:`
    // overwrite path below so a within-hour re-post (the running mean
    // shifts) replaces the value instead of duplicating. Reject a row
    // that targets the HR-bucket prefix but carries a malformed hour
    // suffix — a garbage suffix would mint an un-overwriteable row that
    // the next hour's re-post can't collapse onto. A well-formed bucket
    // (and every non-HR `stats:` / per-sample `uuid` externalId) passes
    // through unchanged.
    if (
      targetsHourlyHeartRateBucket(entry.externalId) &&
      !isHourlyHeartRateStatsExternalId(entry.externalId)
    ) {
      results[index] = {
        index,
        status: "skipped",
        reason: "malformed_hr_bucket_id",
      };
      continue;
    }

    // v1.19.2 (iOS #34 extension) — the per-bucket MIN / MAX are persisted
    // ONLY on a well-formed hourly HR bucket row. A per-sample reading, a
    // per-day cumulative `stats:` total, or a manual entry never carries a
    // spread, so we pin them to null there even if a client mis-sends the
    // fields — `value` stays the single source of truth for those rows.
    const isHrBucket = isHourlyHeartRateStatsExternalId(entry.externalId);
    const valueMin =
      isHrBucket && typeof mapped.valueMin === "number"
        ? mapped.valueMin
        : null;
    const valueMax =
      isHrBucket && typeof mapped.valueMax === "number"
        ? mapped.valueMax
        : null;

    prepared.push({
      index,
      entry,
      row: {
        userId: user.id,
        type: mapped.type,
        value: mapped.value,
        valueMin,
        valueMax,
        unit: mapped.unit,
        // v1.8.6 W6 — honour the per-entry source tag, defaulting to
        // `APPLE_HEALTH` when absent so legacy callers are unchanged.
        source: entry.source ?? "APPLE_HEALTH",
        measuredAt: mapped.takenAt,
        externalId: entry.externalId,
        externalSourceVersion: entry.externalSourceVersion ?? null,
        sleepStage: mapped.sleepStage ?? null,
        // v1.10.0 — categorical events (WX-B). The device's own verdict /
        // severity for an EVENT row; null for every continuous reading.
        rhythmClassification: mapped.rhythmClassification ?? null,
        // v1.4.25 W8c — pass the iOS-supplied device-type through to
        // the row. Stays null for pre-W8c iOS builds; the canonical
        // picker treats null as `unknown` so legacy ingest keeps
        // working without a server-side default.
        deviceType: entry.deviceType ?? null,
      },
    });
  }

  let insertedCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  // v1.11.4 (iOS #2) — subset of `duplicateCount` collapsed by the
  // MANUAL↔APPLE_HEALTH same-reading merge (as opposed to a plain
  // composite-key duplicate). Surfaced as a dedicated wide-event count so
  // an operator can see how often the standalone-pair mirror collapses.
  let crossSourceMergedCount = 0;

  if (prepared.length > 0) {
    // Pre-flight duplicate detection so we can return per-entry status
    // (createMany with skipDuplicates does the dedup but doesn't tell
    // us *which* rows it skipped). We look up existing rows under the
    // composite unique key first, then createMany the survivors.
    // v1.8.6 W6 — `source` is now part of the dedup key, so the lookup
    // matches on (type, source, externalId) per incoming row rather than
    // a single hardcoded `APPLE_HEALTH`. A `MANUAL` row and an
    // `APPLE_HEALTH` row sharing an externalId are distinct, so each must
    // carry its source through the existence probe and the composite key.
    const incomingKeys = prepared.map((p) => ({
      type: p.row.type as Prisma.MeasurementCreateManyInput["type"],
      source: p.row.source as Prisma.MeasurementCreateManyInput["source"],
      externalId: p.row.externalId as string,
    }));

    const existing = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        OR: incomingKeys.map((k) => ({
          type: k.type,
          source: k.source,
          externalId: k.externalId,
        })),
      },
      select: { type: true, source: true, externalId: true },
    });

    const existingSet = new Set(
      existing.map((row) => `${row.type}::${row.source}::${row.externalId}`),
    );

    // v1.11.4 (iOS #2) — same-reading merge for the MANUAL ↔ APPLE_HEALTH
    // mirror duplicate. When the iOS app logs a manual reading offline it
    // mirrors that reading into HealthKit; on pairing, adopt-on-pair
    // uploads it as MANUAL and HealthKit background sync independently
    // re-ingests the mirrored sample as APPLE_HEALTH. The two carry
    // different externalIds + sources, so the composite unique index lets
    // both land — duplicating the whole hand-logged history on first pair.
    // We collapse them at ingest: an incoming MANUAL / APPLE_HEALTH row is
    // dropped as a `duplicate` when a same-reading row of the OPPOSITE
    // source already exists (same type + value + measuredAt within a tight
    // ±2 s window). `stats:*` cumulative rows are excluded — those are
    // per-day aggregates the observer overwrites in place, never
    // hand-entered point readings. See `cross-source-merge.ts` for the
    // full rule + why first-physical-reading-wins (the value is identical
    // between the two rows, so only the source label differs).
    //
    // Pull the opposite-source candidate rows in one widened query: for
    // every mergeable, non-`stats:*` incoming row, look for an opposite-
    // source row of the same type whose measuredAt falls inside the
    // tolerance window. Compared in JS because the value match needs a
    // float epsilon the SQL `IN` can't express.
    const mergeProbes = prepared.filter(
      (p) =>
        isMergeableSource(p.row.source as string) &&
        !isStatsExternalId(p.row.externalId as string),
    );
    const crossSourceCandidates: MergeCandidate[] = [];
    if (mergeProbes.length > 0) {
      const candidateRows = await prisma.measurement.findMany({
        where: {
          userId: user.id,
          deletedAt: null,
          OR: mergeProbes.map((p) => {
            const measuredAt = p.row.measuredAt as Date;
            return {
              type: p.row.type as MeasurementType,
              source: oppositeMergeSource(
                p.row.source as "MANUAL" | "APPLE_HEALTH",
              ),
              measuredAt: {
                gte: new Date(measuredAt.getTime() - MEASURED_AT_TOLERANCE_MS),
                lte: new Date(measuredAt.getTime() + MEASURED_AT_TOLERANCE_MS),
              },
            };
          }),
        },
        select: { type: true, source: true, value: true, measuredAt: true },
      });
      crossSourceCandidates.push(...candidateRows);
    }

    // Rows already chosen for insert earlier in THIS batch — so a MANUAL
    // and an APPLE_HEALTH same-reading arriving in the SAME batch also
    // collapse (the DB probe above only sees rows from prior batches).
    const inBatchCandidates: MergeCandidate[] = [];
    function hasSameReadingSibling(p: Prepared): boolean {
      const incoming = {
        type: p.row.type as MeasurementType,
        source: p.row.source as string,
        value: p.row.value as number,
        measuredAt: p.row.measuredAt as Date,
      };
      if (!isMergeableSource(incoming.source)) return false;
      for (const candidate of crossSourceCandidates) {
        if (isSameReadingAcrossSource(incoming, candidate)) return true;
      }
      for (const candidate of inBatchCandidates) {
        if (isSameReadingAcrossSource(incoming, candidate)) return true;
      }
      return false;
    }

    const toInsert: Prisma.MeasurementCreateManyInput[] = [];
    const toOverwrite: Prepared[] = [];
    for (const p of prepared) {
      const key = `${p.row.type}::${p.row.source}::${p.row.externalId}`;
      if (existingSet.has(key)) {
        // v1.5.0 issue #213 — per-day cumulative `stats:*` rows are
        // intentionally overwritten on a re-post so today's tile reflects
        // the latest HealthKit total instead of freezing at the
        // first-sync value. Sample-class rows keep the immutable
        // duplicate contract.
        if (isStatsExternalId(p.row.externalId as string)) {
          toOverwrite.push(p);
        } else {
          results[p.index] = { index: p.index, status: "duplicate" };
          duplicateCount += 1;
        }
      } else if (
        !isStatsExternalId(p.row.externalId as string) &&
        hasSameReadingSibling(p)
      ) {
        // v1.11.4 (iOS #2) — cross-source same-reading collapse. The
        // physical reading already exists under the opposite client
        // source; drop this mirror copy. Status stays `duplicate` so the
        // iOS sync cursor checkpoints past it exactly as it does for a
        // composite-key duplicate; the `reason` distinguishes it for ops.
        results[p.index] = {
          index: p.index,
          status: "duplicate",
          reason: "cross_source_merge",
        };
        duplicateCount += 1;
        crossSourceMergedCount += 1;
      } else {
        results[p.index] = { index: p.index, status: "inserted" };
        toInsert.push(p.row);
        // Track this row so a same-reading sibling later in the SAME
        // batch collapses against it.
        if (isMergeableSource(p.row.source as string)) {
          inBatchCandidates.push({
            type: p.row.type as MeasurementType,
            source: p.row.source as string,
            value: p.row.value as number,
            measuredAt: p.row.measuredAt as Date,
          });
        }
      }
    }

    if (toOverwrite.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const p of toOverwrite) {
          await tx.measurement.updateMany({
            where: {
              userId: user.id,
              // v1.8.6 W6 — scope the overwrite to the row's own source
              // so a `stats:*` re-post only touches the matching
              // (type, source, externalId) row.
              source: p.row
                .source as Prisma.MeasurementCreateManyInput["source"],
              type: p.row.type as MeasurementType,
              externalId: p.row.externalId as string,
            },
            data: {
              value: p.row.value as number,
              // v1.19.2 (iOS #34 extension) — overwrite the per-bucket
              // spread alongside `value` so a within-hour re-post (the
              // running mean + range shift as more samples land) replaces
              // both. Null for every non-HR-bucket `stats:` overwrite.
              valueMin: p.row.valueMin as number | null,
              valueMax: p.row.valueMax as number | null,
              unit: p.row.unit as string,
              measuredAt: p.row.measuredAt as Date,
              externalSourceVersion: p.row.externalSourceVersion as
                string | null,
              deviceType: p.row.deviceType as Prepared["row"]["deviceType"],
              sleepStage: p.row.sleepStage as Prepared["row"]["sleepStage"],
            },
          });
          results[p.index] = { index: p.index, status: "updated" };
          updatedCount += 1;
        }
      });
    }

    if (toInsert.length > 0) {
      // Chunk to keep individual SQL statements bounded — 200 rows per
      // chunk leaves headroom under Postgres' 65k-parameter cap even
      // with 9-column inserts. `skipDuplicates: true` guards against
      // races where two batch retries land in the same tick — the
      // composite unique index does the actual dedup; skipDuplicates
      // turns the duplicate-PG error into a no-op insert.
      const CHUNK = 200;
      const chunks: Prisma.MeasurementCreateManyInput[][] = [];
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        chunks.push(toInsert.slice(i, i + CHUNK));
      }
      await prisma.$transaction(async (tx) => {
        for (const chunk of chunks) {
          const result = await tx.measurement.createMany({
            data: chunk,
            skipDuplicates: true,
          });
          insertedCount += result.count;
        }
      });

      // v1.4.25 W10 reconcile (senior-dev H-1): the previous "stored
      // vs not-stored" check was an effective no-op. Under standard
      // Postgres semantics, `skipDuplicates` absorbs duplicate-key
      // conflicts but the row is STILL present in the table (written
      // by the other batch that won the race). So every row we
      // attempted is in the DB after the call, and the
      // `!stored.has(...)` branch never fired — leaving the aggregate
      // `inserted` / `duplicate` counts inconsistent with the per-
      // entry statuses under contention.
      //
      // Pragmatic fix: trust the `createMany` return count. The DB
      // round-trip cannot distinguish a row this request wrote from
      // a row the racing request wrote (the unique index sees both
      // as the same key), so we cannot identify the SPECIFIC raced
      // rows. What we CAN do is preserve count integrity for the
      // iOS sync cursor: `insertedCount` is already the truth (it
      // came from `createMany.count`); we only need to downgrade
      // enough per-entry "inserted" statuses to "duplicate" so the
      // per-entry envelope sums match. Order doesn't matter — the
      // client checkpoints past both statuses, and the DB state for
      // either outcome is identical (the row is now stored,
      // single-copy).
      const racedDuplicates = toInsert.length - insertedCount;
      if (racedDuplicates > 0) {
        let downgraded = 0;
        for (const p of prepared) {
          if (downgraded >= racedDuplicates) break;
          if (results[p.index]?.status === "inserted") {
            results[p.index] = { index: p.index, status: "duplicate" };
            duplicateCount += 1;
            downgraded += 1;
          }
        }
      }
    }
  }

  const skipped = results
    .filter((r) => r.status === "skipped")
    .map((r) => ({ index: r.index, reason: r.reason ?? "unknown" }));

  await auditLog("measurement.batch.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted: insertedCount,
      updated: updatedCount,
      duplicates: duplicateCount,
      skipped: skipped.length,
    },
  });

  // v1.5.0 issue #213 — dedicated wide-event annotation so an operator
  // can grep `measurement.batch.stats-overwrite` to see how often
  // per-day cumulative rows are getting re-posted (a healthy ingest
  // flow). Only fires when at least one row was overwritten so the
  // baseline ingest trace is unchanged for batches with no `stats:*`
  // duplicates.
  if (updatedCount > 0) {
    annotate({
      action: { name: "measurement.batch.stats-overwrite" },
      meta: {
        updated: updatedCount,
        processed: entries.length,
      },
    });
  }

  // v1.11.4 (iOS #2) — dedicated annotation for the MANUAL↔APPLE_HEALTH
  // same-reading collapse so an operator can grep
  // `measurement.batch.cross-source-merge` to confirm the standalone-pair
  // mirror duplicate is being absorbed (a healthy first-pair flow). Only
  // fires when at least one row was merged so the baseline ingest trace
  // is unchanged for the common case.
  if (crossSourceMergedCount > 0) {
    annotate({
      action: { name: "measurement.batch.cross-source-merge" },
      meta: {
        merged: crossSourceMergedCount,
        processed: entries.length,
      },
    });
  }

  // v1.4.25 W16c — kick off PR detection for this user. We always
  // enqueue when at least one row was written (or the batch had any
  // measurements to consider) so a single off-day reading still gets
  // evaluated; the warm-up gate inside the detector decides whether
  // it's a record. Suppress push notifications for historical
  // backfills above the silent threshold. Updated `stats:*` rows also
  // count — a per-day-total overwrite can flip the day's value past a
  // personal record.
  if (insertedCount > 0 || updatedCount > 0 || duplicateCount > 0) {
    const silent = entries.length > PR_DETECTION_SILENT_THRESHOLD;
    // v1.18.1 — eventful Vorsorge satisfaction. A matching reading just
    // landed; resolve the user's reminders now rather than waiting on the
    // 15-min cron. Fire-and-forget — the cron reconciles on enqueue miss.
    void enqueueReminderSatisfy(user.id).catch(() => {});
    try {
      await enqueuePrDetection(user.id, { silent });
      await auditLog("personal_records.detection_enqueued", {
        userId: user.id,
        details: {
          source: "measurement.batch",
          batchSize: entries.length,
          silent,
        },
      });
    } catch (err) {
      // Enqueue failure is non-fatal — the 30-minute fallback cron
      // picks the user up in the next slot. Log so the operator
      // notices repeated failures in Wide-Event traffic.
      annotate({
        action: { name: "personal_records.detection_enqueue_failed" },
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  annotate({
    action: { name: "measurement.batch.ingest" },
    meta: {
      processed: entries.length,
      inserted: insertedCount,
      updated: updatedCount,
      duplicates: duplicateCount,
      skipped: skipped.length,
    },
  });

  // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
  // caches when at least one row landed so the next read picks up the
  // ingested batch. Skipped-only ingests don't change state, so we
  // gate the invalidation on `insertedCount > 0 || updatedCount > 0`
  // — overwriting a per-day `stats:*` row changes the day's reading
  // and must invalidate every consumer that reads through this user's
  // measurements.
  if (insertedCount > 0 || updatedCount > 0) {
    // v1.18.9 (#38) — hard-evict so a focus-refetch after a background
    // iOS / Apple-Health batch sync returns post-sync data. A mark-stale
    // would let the `cachedSwr` snapshot serve the pre-batch body on the
    // very next read, leaving the dashboard up to ~180 s stale; the manual
    // measurement routes already pass `{ evict: true }` for the same reason.
    invalidateUserMeasurements(user.id, { evict: true });

    // v1.5.0 — refresh the persistent rollup table for every distinct
    // (type, day) the batch touched. We use the `prepared` rows
    // because `createMany` does not return the inserted rows; the
    // (type, measuredAt) tuples on `prepared` are exactly the row
    // shape we need. Collapsed by day so a 500-row Apple Health
    // batch fires N recomputes (typically <30, one per type-day
    // pair) instead of one per row. Best-effort — a populator hiccup
    // never fails the user's ingest.
    try {
      const insertedKeys = collapseToTypeDayKeys(
        prepared.map((p) => ({
          type: p.row.type as MeasurementType,
          measuredAt:
            p.row.measuredAt instanceof Date
              ? p.row.measuredAt
              : new Date(p.row.measuredAt as string),
        })),
      );
      for (const k of insertedKeys) {
        await recomputeBucketsForMeasurement(user.id, k.type, k.measuredAt);
      }

      // v1.8.0 — drop the cached per-metric assessment rows the ingested
      // types dirty so the next mount / nightly warm pass regenerates
      // them against the new data instead of serving stale text.
      // Fire-and-forget: never a blocker on the user's ingest.
      invalidateStatusInsightsForTypes(
        user.id,
        insertedKeys.map((k) => k.type),
      ).catch((err) => {
        console.warn("[measurements] status-insight invalidate failed", err);
      });
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }
  }

  return apiSuccess({
    processed: entries.length,
    inserted: insertedCount,
    updated: updatedCount,
    duplicates: duplicateCount,
    skipped,
    entries: results,
  });
}
