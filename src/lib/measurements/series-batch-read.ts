/**
 * v1.30.9 — shared core of the batched dashboard daily-series read.
 *
 * Extracted from `GET /api/measurements/series-batch` so the route AND the
 * RSC dashboard prefetch (`src/app/page.tsx`) call ONE code path instead of
 * one HTTP-to-self hop. Behaviour is byte-identical to the pre-extraction
 * route body: load the source-priority ladder ONCE, fan out per-type through
 * the shared `readDailySeries` reader under a `p-limit(4)` cap, and isolate a
 * single type's transient DB reject to an empty slice for THAT type only
 * (never a 500 that blanks every chart in the row).
 */
import pLimit from "p-limit";

import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  readDailySeries,
  type DailySeriesRow,
} from "@/lib/measurements/daily-series-read";
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Concurrency cap for the per-type rollup reads. Mirrors the W-POOL
 * `p-limit(4)` discipline applied across the analytics fan-out so a wide
 * dashboard never packs the shared Prisma pool.
 */
export const SERIES_BATCH_CONCURRENCY = 4;

export interface SeriesBatchResult {
  /** Per-type daily series, keyed by `MeasurementType` — the wire shape. */
  series: Record<string, DailySeriesRow[]>;
  /** How many types degraded to an empty slice on a transient reject. */
  degradedTypes: number;
}

/**
 * Read every requested type's rollup-backed daily series for `[from, to]`.
 * De-dupes the type list (a caller repeating a type doesn't double-read it)
 * while preserving order.
 */
export async function readSeriesBatch(
  userId: string,
  types: readonly MeasurementType[],
  from: Date,
  to: Date,
): Promise<SeriesBatchResult> {
  const uniqueTypes = Array.from(new Set(types)) as MeasurementType[];

  // Load the source-priority ladder ONCE and thread it across every type so
  // the batched reader doesn't re-query it per type.
  const priorityJson = await loadUserSourcePriority(userId);

  const limit = pLimit(SERIES_BATCH_CONCURRENCY);
  let degradedTypes = 0;
  const entries = await Promise.all(
    uniqueTypes.map((type) =>
      limit(async (): Promise<readonly [MeasurementType, DailySeriesRow[]]> => {
        try {
          const rows = await readDailySeries({
            userId,
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

  return { series, degradedTypes };
}
