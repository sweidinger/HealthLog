/**
 * `POST /api/nutrients/batch` — micronutrient day-total ingest (v1.28).
 *
 * iOS posts daily totals for the closed 26-code catalog (vitamins,
 * minerals, water, caffeine) computed via `HKStatisticsCollectionQuery`
 * day-anchored cumulative sums; `day` arrives as YYYY-MM-DD in the
 * user's IANA timezone (the `stats:` day-key contract — the server
 * trusts the string after regex + calendar sanity, no re-derivation).
 *
 * Upsert key = the composite PK (userId, day, nutrient). Re-post
 * replaces amount / unit / externalSourceVersion — last-writer-wins,
 * the day-total contract; per-entry status is `updated` then, never
 * `duplicate`. Validation failures (`unit_mismatch` | `value_out_of_range`
 * | `day_invalid`) are always isolated per entry. The DB write itself runs
 * as two batched groups — a single indexed existence read splits valid
 * entries into a bulk `createMany` (new pairs) and a `$transaction` of
 * per-row updates (existing pairs), the measurements-batch shape. A write
 * failure marks its WHOLE group `skipped upsert_failed` rather than
 * isolating the one entry that would have caused it (unavoidable once the
 * write is batched) — the request itself never fails.
 *
 * Module gate FIRST: the opt-in `nutrients` module (default off)
 * refuses ingest with the 403 `module.disabled` envelope, so a phone
 * whose user never opted in cannot land rows server-side
 * (refuse-ingest posture, mirroring mental health — not surface-only).
 */
import { NextRequest } from "next/server";

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
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { NUTRIENT_CATALOG } from "@/lib/nutrients/catalog";
import {
  MAX_NUTRIENT_ENTRIES_PER_BATCH,
  nutrientBatchSchema,
} from "@/lib/validations/nutrients";

const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * Calendar sanity for an already regex-shaped YYYY-MM-DD key: reject
 * impossible dates (2026-02-31) via a UTC round-trip.
 */
function isRealCalendarDay(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * Upper day bound with timezone slack: "tomorrow" in the most-ahead
 * IANA zone (UTC+14) is at most the UTC calendar date + 2 days, so a
 * key beyond that cannot be a legitimate local day and is corruption.
 */
function maxAcceptableDay(now: Date): string {
  const limit = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  return limit.toISOString().slice(0, 10);
}

type EntryStatus = "inserted" | "updated" | "skipped";
interface EntryResult {
  index: number;
  status: EntryStatus;
  reason?: string;
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  // Module gate first: a disabled module must refuse before any body
  // work, so iOS can branch on the 403 `module.disabled` errorCode and
  // stop syncing rather than retry.
  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `nutrients:batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many batch submissions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 1024 * 1024,
  });
  if (jsonError) return jsonError;

  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "entries" in rawBody &&
    Array.isArray((rawBody as { entries: unknown }).entries) &&
    (rawBody as { entries: unknown[] }).entries.length >
      MAX_NUTRIENT_ENTRIES_PER_BATCH
  ) {
    return apiError(
      `Batch exceeds the ${MAX_NUTRIENT_ENTRIES_PER_BATCH}-entry limit`,
      422,
      { errorCode: "nutrient.batch.too_large" },
    );
  }

  const parsed = nutrientBatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "nutrient.batch.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.batch.invalid",
    });
  }

  const { entries } = parsed.data;
  const dayCeiling = maxAcceptableDay(new Date());

  const results: EntryResult[] = new Array(entries.length);
  const skipped: Array<{ index: number; reason: string }> = [];
  let inserted = 0;
  let updated = 0;

  interface ValidEntry {
    index: number;
    day: string;
    nutrient: (typeof entries)[number]["nutrient"];
    amount: number;
    unit: string;
    externalSourceVersion: string | null;
  }
  const validEntries: ValidEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const definition = NUTRIENT_CATALOG[entry.nutrient];

    // The wire carries the unit deliberately: a µg/mg confusion is a
    // silent 1000× corruption; anything but the catalog's canonical
    // unit skips the entry rather than converting.
    if (entry.unit !== definition.unit) {
      skipped.push({ index: i, reason: "unit_mismatch" });
      results[i] = { index: i, status: "skipped", reason: "unit_mismatch" };
      continue;
    }

    if (entry.amount > definition.plausibleDailyMax) {
      skipped.push({ index: i, reason: "value_out_of_range" });
      results[i] = {
        index: i,
        status: "skipped",
        reason: "value_out_of_range",
      };
      continue;
    }

    if (!isRealCalendarDay(entry.day) || entry.day > dayCeiling) {
      skipped.push({ index: i, reason: "day_invalid" });
      results[i] = { index: i, status: "skipped", reason: "day_invalid" };
      continue;
    }

    validEntries.push({
      index: i,
      day: entry.day,
      nutrient: entry.nutrient,
      amount: entry.amount,
      unit: definition.unit,
      externalSourceVersion: entry.externalSourceVersion ?? null,
    });
  }

  // v1.29 — `source` joined the composite PK (migration 0249) so a manual
  // water entry (source=MANUAL, written by `POST /api/nutrients/water`)
  // coexists with the Apple-synced day total instead of one clobbering the
  // other on the next sync. The batch route always owns the APPLE_HEALTH
  // row.
  //
  // Perf (measurements/batch shape): ONE indexed existence read replaces the
  // per-entry probe-then-upsert (up to 1000 sequential round trips pre-fix).
  // Genuinely new (day, nutrient) pairs land via a single chunked
  // `createMany`; pairs that already exist update via a batched
  // `$transaction` of per-row `update` calls (values differ per row, so a
  // single bulk statement isn't available without raw SQL — this still
  // collapses the per-entry PROBE, and pipelines the writes through one
  // transaction instead of N standalone round trips).
  if (validEntries.length > 0) {
    const existing = await prisma.nutrientIntakeDay.findMany({
      where: {
        userId: user.id,
        source: "APPLE_HEALTH",
        OR: validEntries.map((e) => ({ day: e.day, nutrient: e.nutrient })),
      },
      select: { day: true, nutrient: true },
    });
    const existingKeys = new Set(
      existing.map((r) => `${r.day}::${r.nutrient}`),
    );

    const toInsert: ValidEntry[] = [];
    const toUpdate: ValidEntry[] = [];
    for (const e of validEntries) {
      (existingKeys.has(`${e.day}::${e.nutrient}`) ? toUpdate : toInsert).push(
        e,
      );
    }

    if (toInsert.length > 0) {
      try {
        const result = await prisma.nutrientIntakeDay.createMany({
          data: toInsert.map((e) => ({
            userId: user.id,
            day: e.day,
            nutrient: e.nutrient,
            amount: e.amount,
            unit: e.unit,
            source: "APPLE_HEALTH" as const,
            externalSourceVersion: e.externalSourceVersion,
          })),
          skipDuplicates: true,
        });
        inserted += result.count;
        for (const e of toInsert) {
          results[e.index] = { index: e.index, status: "inserted" };
        }
        // Rare race: a concurrent request claimed one of these keys between
        // our existence probe and this createMany, so skipDuplicates
        // silently dropped that row's write here — measurements/batch
        // accepts the same count-only trade-off for its own createMany race.
        // The DB itself stays consistent (the racing writer's row is
        // stored); only this response's per-row label may be stale for
        // that one entry.
        if (result.count < toInsert.length) {
          annotate({
            action: { name: "nutrient.batch.insert_race" },
            meta: { attempted: toInsert.length, stored: result.count },
          });
        }
      } catch (err: unknown) {
        console.error("[nutrient-batch] bulk insert failed", err);
        for (const e of toInsert) {
          skipped.push({ index: e.index, reason: "upsert_failed" });
          results[e.index] = {
            index: e.index,
            status: "skipped",
            reason: "upsert_failed",
          };
        }
      }
    }

    if (toUpdate.length > 0) {
      try {
        await prisma.$transaction(
          toUpdate.map((e) =>
            prisma.nutrientIntakeDay.update({
              where: {
                userId_day_nutrient_source: {
                  userId: user.id,
                  day: e.day,
                  nutrient: e.nutrient,
                  source: "APPLE_HEALTH",
                },
              },
              data: {
                // Last-writer-wins on the day total: iOS re-posts the
                // current and previous local day on every sync as the
                // totals grow.
                amount: e.amount,
                unit: e.unit,
                externalSourceVersion: e.externalSourceVersion,
              },
            }),
          ),
        );
        updated += toUpdate.length;
        for (const e of toUpdate) {
          results[e.index] = { index: e.index, status: "updated" };
        }
      } catch (err: unknown) {
        // The client-facing `reason` is a closed set (see the file header) —
        // never echo raw exception text into it. Log the real error
        // server-side only (SWC keeps `console.error` in prod) and return
        // the fixed `upsert_failed` member.
        console.error("[nutrient-batch] bulk update failed", err);
        for (const e of toUpdate) {
          skipped.push({ index: e.index, reason: "upsert_failed" });
          results[e.index] = {
            index: e.index,
            status: "skipped",
            reason: "upsert_failed",
          };
        }
      }
    }
  }

  if (inserted + updated > 0) {
    await auditLog("nutrient.batch.ingest", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        processed: entries.length,
        inserted,
        updated,
        skipped: skipped.length,
      },
    });
  }

  annotate({
    action: { name: "nutrient.batch.ingest" },
    meta: {
      processed: entries.length,
      inserted,
      updated,
      skipped: skipped.length,
    },
  });

  return apiSuccess({
    processed: entries.length,
    inserted,
    updated,
    skipped,
    entries: results,
  });
}
