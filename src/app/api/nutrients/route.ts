/**
 * `GET /api/nutrients?days=N` — synced-nutrient window summary (v1.28).
 *
 * Feeds the read-only settings card (Settings → Sources): per nutrient
 * with data inside the window, the latest synced day + total and the
 * count of days carrying data — the smallest honest surface for "what
 * does the server hold". Catalog order, no pagination (≤ 26 rows).
 * Module-gated like the ingest path: 403 `module.disabled` when the
 * opt-in `nutrients` module is off. `userId` is narrowed from auth.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { NUTRIENT_CODES, isNutrientCode } from "@/lib/nutrients/catalog";
import { nutrientOverviewQuerySchema } from "@/lib/validations/nutrients";
import { DEFAULT_TIMEZONE, shiftDateKey, userDayKey } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = nutrientOverviewQuerySchema.safeParse({
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.read.invalid",
    });
  }
  const { days } = parsed.data;

  // v1.30 (DATAINT L4) — window floor anchored on the caller's own local
  // "today" (`User.timezone`), mirroring the sibling `GET
  // /api/nutrients/daily` route. The stored `day` is a local-timezone key,
  // so a UTC floor was off by up to a calendar day at the window edge for
  // any non-UTC user.
  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const todayKey = userDayKey(new Date(), userTz);
  const since = shiftDateKey(todayKey, -(days - 1));

  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId: user.id, day: { gte: since } },
    orderBy: [{ nutrient: "asc" }, { day: "desc" }],
    select: { nutrient: true, unit: true, day: true, amount: true },
  });

  // v1.29 — `source` joined the PK (migration 0249): a day can now carry
  // an APPLE_HEALTH row AND a MANUAL row. Rows arrive day-DESC inside each
  // nutrient, so the first DAY seen per code is the latest; a second row
  // for that same day (the other source) adds to the running total instead
  // of opening a new "day".
  //
  // v1.30 (DATAINT M3) — `daysWithData` used to increment on every row
  // whose `day` differed from the PINNED `latestDay` field, so a second
  // source's row on an already-counted OLDER day (e.g. water logged via
  // both APPLE_HEALTH and MANUAL on the same non-latest day) opened a
  // second "day" for that same calendar date. `daysSeen` is a per-nutrient
  // set of distinct day keys — every row adds to it, so a repeated day
  // (any number of source rows) is counted exactly once.
  const byCode = new Map<
    string,
    {
      unit: string;
      latestDay: string;
      latestAmount: number;
      daysSeen: Set<string>;
    }
  >();
  for (const row of rows) {
    const existing = byCode.get(row.nutrient);
    if (!existing) {
      byCode.set(row.nutrient, {
        unit: row.unit,
        latestDay: row.day,
        latestAmount: row.amount,
        daysSeen: new Set([row.day]),
      });
      continue;
    }
    existing.daysSeen.add(row.day);
    if (row.day === existing.latestDay) {
      existing.latestAmount += row.amount;
    }
  }

  // Catalog order; a stored code that ever fell out of the catalog is
  // dropped from the card rather than crashing the label lookup.
  const nutrients = NUTRIENT_CODES.filter(
    (code) => isNutrientCode(code) && byCode.has(code),
  ).map((code) => {
    const summary = byCode.get(code)!;
    return {
      nutrient: code,
      unit: summary.unit,
      latestDay: summary.latestDay,
      latestAmount: summary.latestAmount,
      daysWithData: summary.daysSeen.size,
    };
  });

  annotate({
    action: { name: "nutrient.intake.read" },
    meta: {
      window_days: days,
      nutrient_count: nutrients.length,
      row_count: rows.length,
    },
  });

  return apiSuccess({ windowDays: days, nutrients });
});
