/**
 * v1.18.6 — GET /api/measurements/series-batch
 *
 * Batched, rollup-backed daily-series endpoint. Returns ALL requested
 * measurement types in ONE response so the dashboard's chart row does a
 * single round-trip instead of one self-fetch per chart (audit finding
 * #2 — the per-chart fan-out).
 *
 * Query: `types` (comma-list of `MeasurementType`), `from`, `to`. Always
 * reads `aggregate=daily` through the rollup tier (`source=rollup`) via
 * the shared `readDailySeries` reader — the SAME path
 * `GET /api/measurements?aggregate=daily&source=rollup` uses, so the
 * per-type series are byte-identical between the two endpoints. Internal
 * per-type reads are capped with `p-limit` to protect the shared Prisma
 * pool.
 *
 * Sleep is deliberately NOT included: SLEEP_DURATION rides a per-night
 * stage reconstruction (`/api/measurements/series?kind=sleep`), not the
 * rollup tier, so the dashboard sleep chart stays on its existing
 * `/series` call. Passing `SLEEP_DURATION` here yields an empty series
 * for that key (the rollup carries no useful per-night collapse) — the
 * client keeps sleep on the dedicated route.
 */
import { NextRequest } from "next/server";
import pLimit from "p-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { returnAllZodIssues } from "@/lib/api-response";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  readDailySeries,
  type DailySeriesRow,
} from "@/lib/measurements/daily-series-read";
import {
  seriesBatchQuerySchema,
  SERIES_BATCH_MAX_TYPES,
} from "@/lib/validations/series-batch";
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Concurrency cap for the per-type rollup reads. Mirrors the W-POOL
 * `p-limit(4)` discipline applied across the analytics fan-out so a
 * wide dashboard never packs the shared Prisma pool.
 */
const SERIES_BATCH_CONCURRENCY = 4;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = seriesBatchQuerySchema.safeParse(params);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  const { types, from, to } = parsed.data;
  // De-dupe while preserving order so a caller repeating a type doesn't
  // double-read it.
  const uniqueTypes = Array.from(new Set(types)) as MeasurementType[];

  // Load the source-priority ladder ONCE and thread it across every type
  // so the batched reader doesn't re-query it per type.
  const priorityJson = await loadUserSourcePriority(user.id);

  // Per-type isolation: a single type's transient DB reject degrades to an
  // empty slice for THAT type only, never a 500 that blanks every chart in
  // the row. The failing chart self-fetches through its existing fallback.
  const limit = pLimit(SERIES_BATCH_CONCURRENCY);
  let degradedTypes = 0;
  const entries = await Promise.all(
    uniqueTypes.map((type) =>
      limit(async (): Promise<readonly [MeasurementType, DailySeriesRow[]]> => {
        try {
          const rows = await readDailySeries({
            userId: user.id,
            type,
            from,
            to,
            priorityJson,
          });
          return [type, rows] as const;
        } catch {
          degradedTypes += 1;
          return [type, []] as const;
        }
      }),
    ),
  );

  const series: Record<string, DailySeriesRow[]> = {};
  for (const [type, rows] of entries) {
    series[type] = rows;
  }

  annotate({
    action: { name: "measurement.series.batch" },
    meta: {
      type_count: uniqueTypes.length,
      total: entries.reduce((sum, [, rows]) => sum + rows.length, 0),
      degraded_types: degradedTypes,
    },
  });

  return apiSuccess({ series });
});

// Re-export the cap so the OpenAPI table + tests share the constant.
export { SERIES_BATCH_MAX_TYPES };
