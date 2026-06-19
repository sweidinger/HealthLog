/**
 * v1.18.6 — shared rollup-backed daily-series reader.
 *
 * Extracted from the `GET /api/measurements` rollup-daily branch so the
 * single-type route AND the batched series endpoint
 * (`GET /api/measurements/series-batch`) read through the SAME path
 * instead of duplicating the rollup SQL + the coverage-fallback fold.
 *
 * `readDailySeries` reproduces the route's `source=rollup` +
 * `aggregate=daily` contract byte-for-byte: collapse per-source rollup
 * rows to the ladder-canonical reading per day, probe for an
 * under-converged rollup window and fold inline when the live table
 * carries more distinct days, and fall through to the live `date_trunc`
 * aggregate when the rollup is empty for the window (brand-new accounts /
 * write-hook race). The returned rows match the wire shape the chart
 * client consumes (`{ type, value, measuredAt, count, minValue?,
 * maxValue? }`).
 */
import { prisma } from "@/lib/db";
import { BUCKET_CAP } from "@/lib/measurements/range-aggregation";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { collapseRollupRowsBySource } from "@/lib/rollups/measurement-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { annotate } from "@/lib/logging/context";
import type { MeasurementType } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

/** Wire row the chart-data client consumes — mirrors the route's shape. */
export interface DailySeriesRow {
  type: string;
  value: number;
  measuredAt: string;
  count?: number;
  minValue?: number | null;
  maxValue?: number | null;
}

const SUSPICIOUS_ROW_FLOOR = 3;
const SUSPICIOUS_WINDOW_DAYS = 7;

/**
 * Read one type's daily series for `[from, to]` through the rollup tier,
 * falling back to the live `date_trunc` aggregate on a coverage miss.
 *
 * `priorityJson` is the user's source-priority ladder (load once per
 * request via `loadUserSourcePriority` and thread it across types so the
 * batched reader doesn't re-query it per type). `cap` defaults to the
 * daily bucket ceiling.
 */
export async function readDailySeries(opts: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  limit?: number;
  priorityJson: unknown;
}): Promise<DailySeriesRow[]> {
  const { userId, type, from, to, priorityJson } = opts;
  const cap = Math.min(opts.limit ?? BUCKET_CAP.daily, BUCKET_CAP.daily);

  const readRollup = async () =>
    collapseRollupRowsBySource(
      await prisma.measurementRollup.findMany({
        where: {
          userId,
          type,
          granularity: "DAY",
          bucketStart: { gte: from, lte: to },
        },
        orderBy: { bucketStart: "asc" },
        select: {
          type: true,
          source: true,
          bucketStart: true,
          mean: true,
          count: true,
          sumValue: true,
          minValue: true,
          maxValue: true,
        },
      }),
      type,
      priorityJson,
    ).slice(0, cap);

  const rollupRows = await readRollup();

  // Coverage-mismatch probe + inline fold (identical to the route).
  const windowMs = to.getTime() - from.getTime();
  const windowDays = Math.ceil(windowMs / 86_400_000);
  let effectiveRows = rollupRows;
  let coverageFallbackFired = false;
  if (
    rollupRows.length > 0 &&
    rollupRows.length < SUSPICIOUS_ROW_FLOOR &&
    windowDays >= SUSPICIOUS_WINDOW_DAYS
  ) {
    const liveDayCountRows = await prisma.$queryRaw<Array<{ days: bigint }>>`
      SELECT COUNT(DISTINCT date_trunc('day', m."measured_at"))::bigint AS days
      FROM measurements m
      WHERE m."user_id"     = ${userId}
        AND m."type"        = ${type}::measurement_type
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        AND m."deleted_at"  IS NULL
    `;
    const liveDays = Number(liveDayCountRows[0]?.days ?? BigInt(0));
    if (liveDays > rollupRows.length) {
      coverageFallbackFired = true;
      try {
        await recomputeUserRollups(userId, {
          types: [type],
          granularities: ["DAY"],
          from,
          to,
        });
        effectiveRows = await readRollup();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        annotate({
          meta: {
            rollup_coverage_fallback_failed: true,
            rollup_coverage_fallback_error: message,
            type,
          },
        });
        effectiveRows = [];
      }
    }
  }

  if (effectiveRows.length > 0) {
    const useSum = CUMULATIVE_HK_TYPES.has(type);
    annotate({
      action: { name: "measurement.list" },
      meta: {
        total: effectiveRows.length,
        type,
        aggregate: "daily",
        source: "rollup",
        coverage_fallback: coverageFallbackFired,
      },
    });
    return effectiveRows.map((r) => ({
      type: r.type,
      value: useSum ? (r.sumValue ?? r.mean * r.count) : r.mean,
      measuredAt: r.bucketStart.toISOString(),
      count: r.count,
      minValue: useSum ? undefined : r.minValue,
      maxValue: useSum ? undefined : r.maxValue,
    }));
  }

  // Live `date_trunc` fallback — rollup empty for the window.
  return readLiveDaily({ userId, type, from, to, cap, priorityJson });
}

/** Live `date_trunc('day', …)` aggregate — the rollup-empty fallback. */
async function readLiveDaily(opts: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  cap: number;
  priorityJson: unknown;
}): Promise<DailySeriesRow[]> {
  const { userId, type, from, to, cap, priorityJson } = opts;
  const truncUnitLiteral = Prisma.raw(`'day'`);
  const useSum = CUMULATIVE_HK_TYPES.has(type);
  const aggregator = useSum
    ? Prisma.raw(`SUM(m."value")::double precision`)
    : Prisma.raw(`AVG(m."value")::double precision`);
  const rankRaw = Prisma.raw(
    buildSourceRankCase(priorityJson, 'm."type"', 'm."source"'),
  );
  const buckets = await prisma.$queryRaw<
    Array<{ type: string; bucket_start: Date; avg: number; cnt: number }>
  >`
    WITH canon AS (
      SELECT DISTINCT ON (m."type", date_trunc(${truncUnitLiteral}, m."measured_at"))
        m."type"                                          AS t,
        date_trunc(${truncUnitLiteral}, m."measured_at")  AS d,
        m."source"                                        AS canon
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        AND m."deleted_at" IS NULL
        AND m."type" = ${type}::measurement_type
      ORDER BY m."type", date_trunc(${truncUnitLiteral}, m."measured_at"), (${rankRaw}), m."source"
    )
    SELECT
      m."type"::text AS type,
      date_trunc(${truncUnitLiteral}, m."measured_at") AS bucket_start,
      ${aggregator} AS avg,
      COUNT(*)::int AS cnt
    FROM measurements m
    JOIN canon c
      ON c.t = m."type"
      AND c.d = date_trunc(${truncUnitLiteral}, m."measured_at")
      AND c.canon = m."source"
    WHERE m."user_id" = ${userId}
      AND m."measured_at" >= ${from}
      AND m."measured_at" <= ${to}
      AND m."deleted_at" IS NULL
      AND m."type" = ${type}::measurement_type
    GROUP BY m."type", bucket_start
    ORDER BY bucket_start ASC
    LIMIT ${cap}
  `;
  annotate({
    action: { name: "measurement.list" },
    meta: { total: buckets.length, type, aggregate: "daily" },
  });
  return buckets.map((b) => ({
    type: b.type,
    value: Number(b.avg),
    measuredAt: b.bucket_start.toISOString(),
    count: Number(b.cnt),
  }));
}
