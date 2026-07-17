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

  // Window floor as a UTC day key. The stored `day` is a local-timezone
  // key, so the UTC floor is off by at most one calendar day at the
  // window edge — fine for a "last N days" summary card.
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const rows = await prisma.nutrientIntakeDay.findMany({
    where: { userId: user.id, day: { gte: since } },
    orderBy: [{ nutrient: "asc" }, { day: "desc" }],
    select: { nutrient: true, unit: true, day: true, amount: true },
  });

  // v1.29 — `source` joined the PK (migration 0249): a day can now carry
  // an APPLE_HEALTH row AND a MANUAL row, so the fold sums amounts
  // WITHIN (nutrient, day) before folding across days. Rows arrive
  // day-DESC inside each nutrient, so the first DAY seen per code is
  // the latest; a second row for that same day (the other source) adds
  // to the running total instead of opening a new "day".
  const byCode = new Map<
    string,
    { unit: string; latestDay: string; latestAmount: number; days: number }
  >();
  for (const row of rows) {
    const existing = byCode.get(row.nutrient);
    if (!existing) {
      byCode.set(row.nutrient, {
        unit: row.unit,
        latestDay: row.day,
        latestAmount: row.amount,
        days: 1,
      });
    } else if (row.day === existing.latestDay) {
      existing.latestAmount += row.amount;
    } else {
      existing.days += 1;
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
      daysWithData: summary.days,
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
