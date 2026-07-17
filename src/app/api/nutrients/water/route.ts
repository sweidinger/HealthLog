/**
 * `POST /api/nutrients/water` — manual water quick-add (v1.29).
 *
 * Writes ONLY the `source="MANUAL"` row for `(userId, day, "water")` —
 * migration 0249 widened the composite PK so this never touches the
 * `source="APPLE_HEALTH"` row the batch route owns. `mode: "add"`
 * increments the manual day total (the quick-add chips: +200/+300/
 * +500 mL + a custom amount); `mode: "set"` overwrites it (the "edit
 * today's total" undo path — there is no per-entry ledger, honest to
 * the day-total storage model). `day` defaults to the caller's current
 * local day (`User.timezone`) when omitted.
 *
 * Module gate first, like every other nutrients route. Idempotency-key
 * aware (`withIdempotency`) so a network retry of a quick-add tap can
 * never double-increment the day total.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { invalidateUserDashboardSnapshot } from "@/lib/cache/invalidate";
import { NUTRIENT_CATALOG } from "@/lib/nutrients/catalog";
import { nutrientWaterWriteSchema } from "@/lib/validations/nutrients";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

const WRITE_RATE_LIMIT_MAX = 60;
const WRITE_RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Calendar sanity for a client-supplied YYYY-MM-DD key (2026-02-31 etc). */
function isRealCalendarDay(day: string): boolean {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postWater));

async function postWater(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `nutrients:water:${user.id}`,
    WRITE_RATE_LIMIT_MAX,
    WRITE_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many requests, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = nutrientWaterWriteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.water.invalid",
    });
  }
  const { amountMl, mode } = parsed.data;

  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const day = parsed.data.day ?? userDayKey(new Date(), userTz);
  if (!isRealCalendarDay(day)) {
    return apiError("Invalid day", 422, {
      errorCode: "nutrient.water.invalid_day",
    });
  }

  const definition = NUTRIENT_CATALOG.water;
  const key = {
    userId_day_nutrient_source: {
      userId: user.id,
      day,
      nutrient: "water",
      source: "MANUAL",
    },
  };

  const row = await prisma.nutrientIntakeDay.upsert({
    where: key,
    create: {
      userId: user.id,
      day,
      nutrient: "water",
      amount: amountMl,
      unit: definition.unit,
      source: "MANUAL",
    },
    update:
      mode === "add"
        ? { amount: { increment: amountMl } }
        : { amount: amountMl },
  });

  // Interactive single-entry write — hard-evict (not mark-stale) so the
  // dashboard water tile reflects the new total on the very next read,
  // matching the mood / medication / measurement posture.
  invalidateUserDashboardSnapshot(user.id);

  annotate({
    action: { name: "nutrient.water.write" },
    meta: { mode, day, amount_ml: amountMl },
  });

  return apiSuccess({
    day: row.day,
    nutrient: "water" as const,
    source: "MANUAL" as const,
    amount: row.amount,
    unit: row.unit,
  });
}
