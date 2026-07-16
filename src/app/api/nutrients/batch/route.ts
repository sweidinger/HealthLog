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
 * `duplicate`. Per-entry failures come back `skipped` with a reason
 * (`unit_mismatch` | `value_out_of_range` | `day_invalid` |
 * `upsert_failed`), never a batch failure — the measurements-batch
 * posture.
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

  const results: EntryResult[] = [];
  const skipped: Array<{ index: number; reason: string }> = [];
  let inserted = 0;
  let updated = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const definition = NUTRIENT_CATALOG[entry.nutrient];

    // The wire carries the unit deliberately: a µg/mg confusion is a
    // silent 1000× corruption; anything but the catalog's canonical
    // unit skips the entry rather than converting.
    if (entry.unit !== definition.unit) {
      skipped.push({ index: i, reason: "unit_mismatch" });
      results.push({ index: i, status: "skipped", reason: "unit_mismatch" });
      continue;
    }

    if (entry.amount > definition.plausibleDailyMax) {
      skipped.push({ index: i, reason: "value_out_of_range" });
      results.push({
        index: i,
        status: "skipped",
        reason: "value_out_of_range",
      });
      continue;
    }

    if (!isRealCalendarDay(entry.day) || entry.day > dayCeiling) {
      skipped.push({ index: i, reason: "day_invalid" });
      results.push({ index: i, status: "skipped", reason: "day_invalid" });
      continue;
    }

    try {
      const key = {
        userId_day_nutrient: {
          userId: user.id,
          day: entry.day,
          nutrient: entry.nutrient,
        },
      };

      // Probe-then-upsert so the response reliably distinguishes
      // `inserted` from `updated` (the mood-bulk pattern; two round
      // trips per entry is fine under the 500-entry cap).
      const existing = await prisma.nutrientIntakeDay.findUnique({
        where: key,
        select: { userId: true },
      });

      await prisma.nutrientIntakeDay.upsert({
        where: key,
        create: {
          userId: user.id,
          day: entry.day,
          nutrient: entry.nutrient,
          amount: entry.amount,
          unit: definition.unit,
          externalSourceVersion: entry.externalSourceVersion ?? null,
        },
        update: {
          // Last-writer-wins on the day total: iOS re-posts the current
          // and previous local day on every sync as the totals grow.
          amount: entry.amount,
          unit: definition.unit,
          externalSourceVersion: entry.externalSourceVersion ?? null,
        },
      });

      if (existing) {
        updated += 1;
        results.push({ index: i, status: "updated" });
      } else {
        inserted += 1;
        results.push({ index: i, status: "inserted" });
      }
    } catch (err: unknown) {
      // The client-facing `reason` is a closed set (see the file header) —
      // never echo raw exception text into it. Log the real error
      // server-side only (SWC keeps `console.error` in prod) and return the
      // fixed `upsert_failed` member.
      console.error("[nutrient-batch] upsert failed", err);
      const reason = "upsert_failed";
      skipped.push({ index: i, reason });
      results.push({ index: i, status: "skipped", reason });
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
