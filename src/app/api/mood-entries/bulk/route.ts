/**
 * `POST /api/mood-entries/bulk` — iOS SyncMode bulk backfill.
 *
 * When iOS pairs a fresh device with the server, it drains its local
 * SwiftData mood log via this endpoint in one shot. Per-entry UPSERT
 * semantics keyed by `externalId` so re-runs are idempotent.
 *
 * Body:
 *   { entries: BulkMoodEntry[] }     — capped at 500 per call.
 *
 * Response (always 200):
 *   {
 *     processed,
 *     inserted,
 *     duplicates,
 *     skipped: [{ index, reason }, ...],
 *     entries: [{ index, status, id? }, ...]
 *   }
 *
 * Locked contract — see `.planning/v15-ios-handoff/06-ios-responsibilities.md`
 * §"Cumulative metrics" sibling section for the SyncMode rationale,
 * and `08-locked-contracts.md` §2 for the batch envelope shape.
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
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  getScoreForMood,
  moodLevelEnum,
  moodSourceEnum,
} from "@/lib/validations/moodlog";
import { moodDateKey, DEFAULT_TIMEZONE } from "@/lib/mood/date-key";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";
import { pushMoodEntriesToMoodLog } from "@/lib/moodlog/push";
import { createTagLinks } from "@/lib/mood/tag-links";

const MAX_ENTRIES_PER_BATCH = 500;
const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkEntrySchema = z.object({
  mood: moodLevelEnum,
  tags: z.array(z.string().max(50)).max(20).optional(),
  /**
   * v1.12.0 — structured-tag keys from the catalog (`mood_tags.key`),
   * mirroring the single-entry `POST /api/mood-entries` contract.
   * Without this the bulk path Zod-stripped the field, so iOS-sent
   * taxonomy links were silently dropped on the adopt-on-pair backfill.
   * The server resolves each key to a `MoodTag` row and writes the
   * `MoodEntryTagLink` join; unknown keys are dropped silently (the
   * catalog is the source of truth). Bounds match the single-entry
   * `structuredTagKeys` schema so one entry can't fan out an unbounded
   * link set.
   */
  tagKeys: z.array(z.string().max(60)).max(30).optional(),
  /**
   * v1.12.0 — rated mood factors (`kind = 'RATED'` catalog tags carrying
   * a per-entry score). Parallel to the binary `tagKeys`; persisted on
   * `MoodEntryTagLink.rating`. The outer 1..5 here is the envelope; the
   * server rejects a rating outside the resolved factor's own
   * `scaleMin..scaleMax` (e.g. 1..2 for `factor_conflict`) — on the bulk
   * path that marks the single entry `skipped`, never the whole batch.
   */
  ratedFactors: z
    .array(
      z.object({ key: z.string().max(60), rating: z.number().int().min(1).max(5) }),
    )
    .max(30)
    .optional(),
  note: z.string().max(500).optional(),
  moodLoggedAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
  source: moodSourceEnum.optional().default("MANUAL"),
  /**
   * Optional iOS-side identifier (e.g. SwiftData row UUID) that lets
   * the bulk endpoint dedup idempotently when iOS retries the same
   * batch after a network hiccup. Mirrors the `externalId` posture on
   * the measurements batch endpoint. NULL = no dedup hint; the
   * existing `(userId, date, moodLoggedAt)` unique index still
   * protects against straight-up duplicates.
   */
  externalId: z.string().min(1).max(120).optional(),
});

const bulkPayloadSchema = z.object({
  entries: z.array(bulkEntrySchema).min(1).max(MAX_ENTRIES_PER_BATCH),
});

type EntryStatus = "inserted" | "duplicate" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
  id?: string;
  // v1.12.1 — echo the client-supplied source-stable id back on each
  // result so iOS can map a server row id onto its local SwiftData row
  // without re-deriving it. Omitted when the entry sent no externalId.
  externalId?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulk));

async function postBulk(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `mood-entries:bulk:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length > MAX_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "mood.bulk.too_large" },
    );
  }

  const parsed = bulkPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    // v1.4.43 W6 — bulk mood ingest; keep the `mood.bulk.invalid`
    // errorCode meta intact so the iOS Sync engine's retry classifier
    // still branches on it. Adds the audit-ledger breadcrumb keyed
    // `mood.bulk.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "mood.bulk.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; bulk mood
    // entries carry free-text `note` + `tags` per row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "mood.bulk.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.bulk.invalid",
    });
  }

  const { entries } = parsed.data;
  const tz = user.timezone ?? DEFAULT_TIMEZONE;

  const results: EntryResult[] = [];
  let inserted = 0;
  let duplicates = 0;
  const skipped: Array<{ index: number; reason: string }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const date = moodDateKey(entry.moodLoggedAt, tz);
    const score = getScoreForMood(entry.mood);

    try {
      // v1.12.1 — when the entry carries a source-stable `externalId`,
      // dedup on the NULL-distinct `(userId, source, externalId)` key so a
      // re-post with the same id (an iOS retry after a network hiccup, or a
      // second adopt-on-pair backfill) updates the existing row in place
      // instead of minting a duplicate when `moodLoggedAt` re-rounds /
      // re-zones. Absent → the legacy `(userId, date, moodLoggedAt)` key.
      // `source` carries a schema default of "MANUAL"; resolve it once so
      // the probe, upsert key, and create write all agree on the value.
      const resolvedSource = entry.source;
      const probeWhere = entry.externalId
        ? {
            userId_source_externalId: {
              userId: user.id,
              source: resolvedSource,
              externalId: entry.externalId,
            },
          }
        : {
            userId_date_moodLoggedAt: {
              userId: user.id,
              date,
              moodLoggedAt: entry.moodLoggedAt,
            },
          };

      // Probe-then-upsert so the response reliably distinguishes
      // "inserted" from "duplicate". Two round-trips per entry is
      // acceptable given the 500-entry cap; a more cache-friendly
      // shape (batched probe) is a v1.4.31 optimisation if the cap
      // grows.
      const existing = await prisma.moodEntry.findUnique({
        where: probeWhere,
        select: { id: true },
      });

      const result = await prisma.moodEntry.upsert({
        where: probeWhere,
        create: {
          userId: user.id,
          date,
          tz,
          mood: entry.mood,
          score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          note: entry.note ?? null,
          source: resolvedSource,
          externalId: entry.externalId ?? null,
          moodLoggedAt: entry.moodLoggedAt,
        },
        update: {
          // Last-writer-wins on the mood + tags + note triple. The
          // iOS client only re-posts an existing entry when it has
          // new data; the server trusts that decision. When the dedup
          // key is `externalId`, also refresh `date` / `moodLoggedAt`
          // so a re-zoned re-import lands the corrected wall-clock on
          // the same row.
          mood: entry.mood,
          score,
          tags: entry.tags ? JSON.stringify(entry.tags) : null,
          note: entry.note ?? null,
          ...(entry.externalId
            ? { date, moodLoggedAt: entry.moodLoggedAt }
            : {}),
        },
      });

      // v1.12.0 — persist structured-tag links, mirroring the
      // single-entry `createTagLinks` path. Additive + idempotent:
      // `createTagLinks` resolves keys against the catalog (dropping
      // unknown keys) and `skipDuplicates` on the join insert keeps a
      // re-posted entry from minting duplicate links. Runs for both
      // fresh and re-posted (upserted) rows so a backfill that adds tag
      // keys on a second pass still lands them.
      // v1.12.0 — rated factors ride the same path; an out-of-scale
      // rating throws `RatedFactorOutOfRangeError`, which the per-entry
      // catch below turns into a `skipped` result (the rest of the batch
      // still lands). The mood row itself already upserted, so a skipped
      // factor leaves a valid entry with no rated links.
      if (
        (entry.tagKeys && entry.tagKeys.length > 0) ||
        (entry.ratedFactors && entry.ratedFactors.length > 0)
      ) {
        await createTagLinks(
          result.id,
          user.id,
          entry.tagKeys ?? [],
          prisma,
          entry.ratedFactors ?? [],
        );
      }

      if (existing) {
        duplicates += 1;
        results.push({
          index: i,
          status: "duplicate",
          id: result.id,
          ...(entry.externalId ? { externalId: entry.externalId } : {}),
        });
      } else {
        inserted += 1;
        results.push({
          index: i,
          status: "inserted",
          id: result.id,
          ...(entry.externalId ? { externalId: entry.externalId } : {}),
        });
      }
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message.slice(0, 120) : "upsert_failed";
      skipped.push({ index: i, reason });
      results.push({
        index: i,
        status: "skipped",
        reason,
        ...(entry.externalId ? { externalId: entry.externalId } : {}),
      });
    }
  }

  await auditLog("mood.bulk.ingest", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  annotate({
    action: { name: "mood.bulk.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      duplicates,
      skipped: skipped.length,
    },
  });

  // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches
  // when at least one row landed so the next read picks up the ingested
  // batch. Skipped / duplicate-only ingests are no-ops.
  if (inserted > 0) {
    invalidateUserMood(user.id);
  }

  // v1.4.39 W-MOOD — refresh the rollup tier for every distinct day
  // touched by this batch. The bulk endpoint is an iOS one-shot
  // backfill so the batch can span many days; we collapse to the
  // unique `(user, dayStart)` set first to bound the recompute count.
  // Best-effort: rollup failures must not surface as 5xx.
  if (inserted > 0 || duplicates > 0) {
    const touchedDayStarts = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      const status = results[i]?.status;
      if (status === "inserted" || status === "duplicate") {
        const d = entries[i].moodLoggedAt;
        const dayStart = Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate(),
        );
        touchedDayStarts.add(dayStart);
      }
    }
    try {
      await Promise.all(
        Array.from(touchedDayStarts).map((t) =>
          recomputeMoodBucketsForEntry(user.id, new Date(t)),
        ),
      );
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }
  }

  // v1.4.50 — reverse-sync the freshly-inserted batch to MoodLog so
  // an iOS one-shot backfill surfaces in both apps. Duplicates and
  // skips do NOT push (MoodLog already has them — or we'd just be
  // retrying a known failure). The helper filters MOODLOG-sourced
  // rows internally so a re-ingest of a MoodLog pull doesn't echo.
  if (inserted > 0) {
    const pushBatch: Array<{
      date: string;
      moodLoggedAt: Date;
      mood: string;
      note: string | null;
      tags: string | null;
      source: string;
    }> = [];
    for (let i = 0; i < entries.length; i++) {
      if (results[i]?.status !== "inserted") continue;
      const e = entries[i];
      const tz = user.timezone ?? DEFAULT_TIMEZONE;
      pushBatch.push({
        date: moodDateKey(e.moodLoggedAt, tz),
        moodLoggedAt: e.moodLoggedAt,
        mood: e.mood,
        note: e.note ?? null,
        tags: e.tags ? JSON.stringify(e.tags) : null,
        source: e.source,
      });
    }
    if (pushBatch.length > 0) {
      void pushMoodEntriesToMoodLog(user.id, pushBatch).catch(() => {
        /* helper wraps errors in wide-event warnings; defence-in-depth */
      });
    }
  }

  return apiSuccess({
    processed: entries.length,
    inserted,
    duplicates,
    skipped,
    entries: results,
  });
}
