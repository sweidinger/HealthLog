import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  createMeasurementSchema,
  createBatchMeasurementSchema,
  listMeasurementsSchema,
  getUnitForType,
} from "@/lib/validations/measurement";
import {
  BUCKET_CAP,
  type AggregateGrain,
} from "@/lib/measurements/range-aggregation";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import {
  canonicalDailyTimestamp,
  dayKeyForUserTz,
  localDayWindow,
} from "@/lib/measurements/drain-per-sample-cumulative";
import { withIdempotency } from "@/lib/idempotency";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/comprehensive-generate";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import {
  recomputeBucketsForMeasurement,
  collapseToTypeDayKeys,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";
import {
  collapseRollupRowsBySource,
  loadUserSourcePriority,
} from "@/lib/rollups/measurement-read";
import {
  reconstructSleepSessions,
  pickMainNightAndNaps,
} from "@/lib/analytics/sleep-night";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { NextRequest } from "next/server";
import type {
  MeasurementType,
  MeasurementSource,
  GlucoseContext,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMeasurementsSchema.safeParse(params);
  if (!parsed.success) {
    // v1.4.43 W6 — surface every Zod issue under `details.issues` so a
    // multi-field iOS query (chart loader bug, drill-down regression)
    // doesn't iterate one error per round-trip. Best-effort audit-
    // ledger breadcrumb keyed `measurements.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "measurements.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row to keep
    // any free-text query slice (custom `dayKey`, attacker-shaped
    // `type=`) out of the persisted breadcrumb.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "measurements.list.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const {
    type,
    from,
    to,
    limit,
    offset,
    sortBy,
    sortDir,
    aggregate,
    source,
    sourceEq,
    valueMin,
    valueMax,
    groupBy,
    dayKey,
  } = parsed.data;

  const where = {
    userId: user.id,
    // v1.4.40 W-DELETED — soft-deleted readings are invisible to every
    // list / count / aggregate read. The dedicated `sync/state` route
    // keeps surfacing them via its own filter so iOS can reconcile
    // tombstones; every other consumer (list view, analytics fan-out,
    // dashboard read paths) must never include them.
    deletedAt: null,
    ...(type && { type: type as MeasurementType }),
    // v1.15.13 — management-list source filter. Distinct from the
    // `source=rollup` opt-in above (which selects the rollup read tier);
    // `sourceEq` narrows the plain list to one ingest source.
    ...(sourceEq && { source: sourceEq }),
    // v1.18.5 — value-range filter (backlog G). Open-ended on either side;
    // the validator has already rejected an inverted `valueMin > valueMax`.
    ...(valueMin != null || valueMax != null
      ? {
          value: {
            ...(valueMin != null && { gte: valueMin }),
            ...(valueMax != null && { lte: valueMax }),
          },
        }
      : {}),
    ...(from || to
      ? {
          measuredAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  // v1.11.5 — sleep is read row-per-STAGE (≈5 rows/night × source-count),
  // not a spot sample and not a cumulative day-sum. A plain list query for
  // SLEEP_DURATION would leak every stage segment as its own "value" — the
  // "many small numbers that stand for themselves" complaint. Route it
  // through the canonical per-night aggregation (the same helper the chart
  // series + dashboard tile use) so a sleep list returns one row per night
  // carrying the night's TIME ASLEEP, with a `dayKey` drill-down to that
  // night's stage segments. Storage is untouched; only the display
  // collapses. Runs ahead of the cumulative branches because sleep is in
  // neither CUMULATIVE_HK_TYPES nor the spot-sample set.
  if (type === "SLEEP_DURATION") {
    return sleepListResponse(user, {
      from,
      to,
      limit,
      offset,
      sortDir,
      dayKey,
    });
  }

  // v1.4.37 W7c — list-view drill-down to per-sample rows for a single
  // calendar day in the user's IANA timezone. Resolves the day's UTC
  // bounds against `User.timezone`, then runs a plain `findMany` so the
  // expandable list row shows every per-sample chunk the daily collapse
  // hid. Gated to cumulative HK types — the spot-sample types render
  // one-row-per-event already and have nothing to drill into.
  if (dayKey && type && CUMULATIVE_HK_TYPES.has(type as MeasurementType)) {
    const tz =
      user.timezone && user.timezone.length > 0
        ? user.timezone
        : "Europe/Berlin";
    // Resolve `[dayStart, dayEnd)` for the requested calendar day in
    // the user's local zone. v1.4.37 W10 — `localDayWindow` honours
    // DST: the previous shape (`canonicalDailyTimestamp ± 12 h`)
    // silently leaked or hid one hour of samples on spring-forward
    // (23-h day) and fall-back (25-h day) by always spanning exactly
    // 24 h. Works for every IANA offset including sub-half-hour
    // zones (Asia/Kathmandu UTC+5:45, Pacific/Chatham UTC+12:45).
    const { dayStart, dayEnd } = localDayWindow(dayKey, tz);
    const samples = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: type as MeasurementType,
        measuredAt: { gte: dayStart, lt: dayEnd },
        deletedAt: null,
      },
      orderBy: { measuredAt: sortDir },
      // v1.4.38 — the 1000-row cap now lives on the validator (refine
      // on `(limit, dayKey)` returning 422 when a caller asks for
      // more). The route reads `limit` straight through because the
      // validator has already clamped it.
      take: limit,
    });
    annotate({
      action: { name: "measurement.list" },
      meta: { total: samples.length, type, dayKey, mode: "drill-down" },
    });
    return apiSuccess({
      measurements: samples,
      meta: { total: samples.length, limit, offset: 0, dayKey },
    });
  }

  // v1.4.37 W7c — collapsed "one row per day" mode for cumulative
  // types. The list page renders the day's SUM as a single synthesised
  // row with a `sampleCount` chevron that drills back into the
  // per-sample rows via the `dayKey=…` branch above.
  if (
    groupBy === "day" &&
    type &&
    CUMULATIVE_HK_TYPES.has(type as MeasurementType)
  ) {
    const tz =
      user.timezone && user.timezone.length > 0
        ? user.timezone
        : "Europe/Berlin";
    const rows = await prisma.measurement.findMany({
      where,
      orderBy: { measuredAt: "asc" },
      // Per-sample row scan within the requested window — bounded by
      // the existing `limit` cap (default 100, max 5000) so a wide
      // multi-year window can still walk the whole range when the
      // chart explicitly asks for it.
      take: limit,
      select: {
        id: true,
        type: true,
        value: true,
        unit: true,
        source: true,
        measuredAt: true,
        notes: true,
      },
    });

    // Group by the user's calendar day, sum values, keep a representative
    // unit/source from the bucket's first row so the rendered row carries
    // a sensible label even when the bucket mixes sources.
    type Bucket = {
      dayKey: string;
      total: number;
      sampleCount: number;
      latest: Date;
      unit: string;
      source: string;
    };
    const buckets = new Map<string, Bucket>();
    for (const row of rows) {
      const key = dayKeyForUserTz(row.measuredAt, tz);
      const slot = buckets.get(key);
      if (!slot) {
        buckets.set(key, {
          dayKey: key,
          total: row.value,
          sampleCount: 1,
          latest: row.measuredAt,
          unit: row.unit,
          source: row.source,
        });
      } else {
        slot.total += row.value;
        slot.sampleCount += 1;
        if (row.measuredAt > slot.latest) slot.latest = row.measuredAt;
      }
    }

    const measurements = Array.from(buckets.values())
      .map((b) => ({
        // Synthetic id so the list-row key stays stable across pages
        // and the row never collides with a real `Measurement.id`.
        id: `day:${type}:${b.dayKey}`,
        type,
        value: b.total,
        unit: b.unit,
        source: b.source,
        // Anchor the row's timestamp to local noon so the row sorts
        // cleanly between same-day spot samples — matches the
        // `canonicalDailyTimestamp` convention used by the drain.
        measuredAt: canonicalDailyTimestamp(b.dayKey, tz).toISOString(),
        notes: null,
        dayKey: b.dayKey,
        sampleCount: b.sampleCount,
      }))
      .sort((a, b) => {
        const cmp = a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });

    annotate({
      action: { name: "measurement.list" },
      meta: {
        total: measurements.length,
        type,
        groupBy: "day",
        rowsScanned: rows.length,
      },
    });
    return apiSuccess({
      measurements,
      meta: {
        total: measurements.length,
        limit,
        offset: 0,
        groupBy: "day",
      },
    });
  }

  // v1.4.28 FB-D2 — server-side aggregation. Gated on an explicit
  // `aggregate` param so the iOS contract (raw `MeasurementWireDTO`
  // shape on `GET /api/measurements`) is byte-stable for any caller
  // that omits the new query parameter. The chart-data client opts
  // in; iOS does not.
  //
  // R4-CODE-C1 — `take` no longer applies BEFORE bucketising. The
  // aggregation runs in Postgres via `date_trunc`, the bucket cap is
  // applied AFTER, so a 1-year `aggregate=daily` window walks every
  // row in the window and returns up to 365 buckets per type instead
  // of truncating to the first N raw rows.
  //
  // SD-H1 — "All time" range semantics. When the chart's "All" tab
  // is active, the client passes `from` = the user's earliest
  // measurement (or a sentinel like 1970-01-01) plus `to` = now plus
  // `aggregate=monthly` (or `weekly` when full history < 2 years).
  // The route's response is bounded by the `BUCKET_CAP` ceiling per
  // grain (monthly: 24, weekly: 105, daily: 365) so a multi-decade
  // account never paints an unbounded series.
  // v1.4.36 W1 — rollup-table read for daily aggregates.
  //
  // The Insights trends row fires three parallel
  // `GET /api/measurements?type=…&aggregate=daily&limit=5000` requests
  // (BP_SYS / BP_DIA / WEIGHT). The legacy `date_trunc('day', …)`
  // path scanned the measurements table each time — a full year window
  // on the maintainer's account hit 3 × ~3 s on the v1.4.35 HAR. Reading from
  // the persistent `measurement_rollups` DAY buckets drops each call
  // to a small indexed read against the ~5 k-row rollup table.
  //
  // Gating:
  //   - `source=rollup` is an explicit client opt-in (`@/lib/validations/measurement`
  //     constrains the enum to `["rollup"]`).
  //   - We require `aggregate=daily` because the rollup populator only
  //     keeps DAY buckets on the synchronous write hook; the WEEK /
  //     MONTH paths still depend on the async pg-boss recomputes which
  //     may lag behind a recent write.
  //   - `type` is mandatory so the response shape mirrors the per-type
  //     ask the chart code makes.
  //   - When the rollup window returns zero rows we fall through to
  //     the live `date_trunc` path so a brand-new account whose
  //     populator hasn't caught up still sees a correct chart on its
  //     first render.
  if (source === "rollup" && aggregate === "daily" && type && from && to) {
    const cap = Math.min(limit, BUCKET_CAP.daily);
    // v1.11.1 — rollup rows are per source; collapse overlapping sources to the
    // ladder-canonical reading per day before the chart consumes them, so a
    // dual-source vital paints one line, not two stacked points per day.
    const priorityJson = await loadUserSourcePriority(user.id);
    const rollupRows = collapseRollupRowsBySource(
      await prisma.measurementRollup.findMany({
        where: {
          userId: user.id,
          type: type as MeasurementType,
          granularity: "DAY",
          bucketStart: { gte: from, lte: to },
        },
        orderBy: { bucketStart: "asc" },
        // Fetch beyond the bucket cap pre-collapse — N sources per day can
        // exceed `cap` rows before the per-day collapse reduces them.
        select: {
          type: true,
          source: true,
          bucketStart: true,
          mean: true,
          count: true,
          // v1.4.39 W-SUM — the writer now populates `sum_value` on
          // every fold. The cumulative metric path consumes the column
          // directly instead of reconstructing `mean * count`; the
          // legacy fallback below covers the boot-backfill convergence
          // window when an existing bucket pre-dates v1.4.39.
          sumValue: true,
          minValue: true,
          maxValue: true,
        },
      }),
      type as MeasurementType,
      priorityJson,
    ).slice(0, cap);
    // v1.4.39.2 — coverage-mismatch fallback. v1.4.39.1 wired the
    // rollup write hook into the previously-bypassed Withings sync,
    // /api/import, and admin-restore paths, and widened the boot-time
    // backfill discovery to per-(user, type, day). Together those
    // changes ensure new writes and post-deploy restarts converge the
    // rollup tier for every measurement type the user has logged. They
    // do NOT, however, guarantee convergence inside a single request
    // when the boot backfill has not yet finished folding the user's
    // historic rows: a chart query lands first, the rollup table still
    // carries 2 rows for a 30-day BP_SYS window, and the route's pre-
    // v1.4.39.2 "rollup wins on length > 0" short-circuit returns the
    // sparse rollup. The chart trips its `< 3 daily points` empty-state
    // even though `measurements` holds the full 30 days.
    //
    // This branch closes that gap. When the rollup row count is
    // suspiciously low for the requested window (≥ 7 days asked and
    // < 3 rollup rows present), we probe `measurements` for the actual
    // distinct-day count over the same window. If `measurements`
    // carries strictly more days than the rollup, the rollup is
    // under-converged: we fold the (user, type, DAY, [from, to])
    // partition inline, re-read the rollup, and return the refreshed
    // rows. The inline fold is bounded by the window + type so it is
    // small (~30 buckets × one type for the dashboard chart's 30-day
    // window) and finishes well inside the request budget.
    //
    // The probe runs only on suspicious rollups so the covered-tenant
    // happy path stays a single indexed read. The maintainer's tenant on a 30-day
    // BP_SYS window pre-fix returned 2 rollup rows and hit `total: 2`
    // in the live trace; post-fix the probe finds ~30 distinct days in
    // `measurements`, folds them, and the chart paints all 30.
    const windowMs = to.getTime() - from.getTime();
    const windowDays = Math.ceil(windowMs / 86_400_000);
    const SUSPICIOUS_ROW_FLOOR = 3;
    const SUSPICIOUS_WINDOW_DAYS = 7;
    let effectiveRows = rollupRows;
    let coverageFallbackFired = false;
    if (
      rollupRows.length > 0 &&
      rollupRows.length < SUSPICIOUS_ROW_FLOOR &&
      windowDays >= SUSPICIOUS_WINDOW_DAYS
    ) {
      // Cheap probe — one indexed range scan over
      // `(user_id, type, measured_at)`. Returns the count of distinct
      // calendar days the live table holds for the window.
      const liveDayCountRows = await prisma.$queryRaw<Array<{ days: bigint }>>`
        SELECT COUNT(DISTINCT date_trunc('day', m."measured_at"))::bigint AS days
        FROM measurements m
        WHERE m."user_id"     = ${user.id}
          AND m."type"        = ${type}::measurement_type
          AND m."measured_at" >= ${from}
          AND m."measured_at" <= ${to}
          AND m."deleted_at"  IS NULL
      `;
      const liveDays = Number(liveDayCountRows[0]?.days ?? BigInt(0));
      if (liveDays > rollupRows.length) {
        coverageFallbackFired = true;
        try {
          // Inline fold of the (user, type, DAY, window) partition.
          // Bounded by the window so it stays small even on a
          // power-user account; the upsert is idempotent against the
          // composite primary key.
          await recomputeUserRollups(user.id, {
            types: [type as MeasurementType],
            granularities: ["DAY"],
            from,
            to,
          });
          // Re-read so this request returns the converged rows. The
          // next chart paint hits the same warm rollup without paying
          // the fallback cost. v1.11.1 — collapse per-source rows to the
          // canonical reading per day, same as the initial read.
          effectiveRows = collapseRollupRowsBySource(
            await prisma.measurementRollup.findMany({
              where: {
                userId: user.id,
                type: type as MeasurementType,
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
            type as MeasurementType,
            priorityJson,
          ).slice(0, cap);
        } catch (err) {
          // Best-effort — fall back to the legacy live aggregate path
          // below if the fold itself failed so the chart paints
          // something sensible regardless. `annotate` carries the
          // surface so ops can spot a silent populator regression.
          const message = err instanceof Error ? err.message : String(err);
          annotate({
            meta: {
              rollup_coverage_fallback_failed: true,
              rollup_coverage_fallback_error: message,
              type,
            },
          });
          // Drop into the live `date_trunc` branch below.
          effectiveRows = [];
        }
      }
    }
    if (effectiveRows.length > 0) {
      // Cumulative metrics (steps, active energy, distance, flights,
      // daylight) store `mean` per bucket but the chart needs the
      // daily SUM. v1.4.39 W-SUM — read `sumValue` directly; fall back
      // to `mean * count` only when the legacy NULL surfaces (pre-
      // v1.4.39 rows still waiting for the boot-time backfill to
      // converge). `mean * count` is algebraically equivalent to
      // SUM(value) for a single-source day because AVG = SUM / COUNT.
      const useSum =
        type != null && CUMULATIVE_HK_TYPES.has(type as MeasurementType);
      const measurements = effectiveRows.map((r) => ({
        type: r.type,
        value: useSum ? (r.sumValue ?? r.mean * r.count) : r.mean,
        measuredAt: r.bucketStart.toISOString(),
        count: r.count,
        // v1.8.5 — per-day min / max so the chart can shade an
        // Apple-Health-style range band around the daily mean line.
        // Omitted for cumulative metrics (steps, distance, …) where the
        // daily value is a SUM, not a central tendency, so an intra-day
        // spread band carries no meaning.
        minValue: useSum ? undefined : r.minValue,
        maxValue: useSum ? undefined : r.maxValue,
      }));
      annotate({
        action: { name: "measurement.list" },
        meta: {
          total: measurements.length,
          type,
          aggregate: "daily",
          source: "rollup",
          coverage_fallback: coverageFallbackFired,
        },
      });
      return apiSuccess({
        measurements,
        meta: {
          total: measurements.length,
          limit: cap,
          offset: 0,
          aggregate: "daily",
        },
      });
    }
    // Fall through to the live aggregate path when the rollup is
    // empty for the requested window — covers brand-new accounts +
    // the race between a recent write hook and the read, and the
    // coverage-fallback inline-fold-failed branch above.
  }

  if (aggregate && aggregate !== "raw" && from && to) {
    const grain: AggregateGrain = aggregate;
    const cap = Math.min(limit, BUCKET_CAP[grain]);
    // Postgres `date_trunc` requires the unit argument to be a SQL
    // literal — it cannot be supplied as a prepared-statement parameter.
    // The previous `${truncUnit}` (bound) interpolation 500'd in
    // production for every grain; the grain string is restricted to
    // the `AggregateGrain` enum upstream via the Zod schema, so
    // injecting the mapped unit via `Prisma.raw` is safe. The mapping
    // also fixes the "weekly"/"monthly" passthrough — Postgres expects
    // the singular forms `week`/`month`.
    const TRUNC_UNIT: Record<Exclude<AggregateGrain, "raw">, string> = {
      daily: "day",
      weekly: "week",
      monthly: "month",
    };
    const truncUnit = TRUNC_UNIT[grain];
    const truncUnitLiteral = Prisma.raw(`'${truncUnit}'`);
    // Cumulative HK types (steps, active energy, flights, distance,
    // daylight) are partial-day increments — averaging across the day
    // understates the daily total by the per-bucket sample count.
    // SUM for those; AVG for spot metrics (BP, weight, pulse, BG,
    // body fat, mood, sleep). See R-A finding 2.
    const useSum =
      type != null && CUMULATIVE_HK_TYPES.has(type as MeasurementType);
    const aggregator = useSum
      ? Prisma.raw(`SUM(m."value")::double precision`)
      : Prisma.raw(`AVG(m."value")::double precision`);
    // v1.11.1 — collapse overlapping sources to the ladder-canonical reading
    // per (type, bucket) before aggregating, so this cold/uncovered fallback
    // agrees with the warm rollup path. `canon` picks the winning source for
    // each (type, bucket) via the per-user rank; the join keeps only its rows.
    const priorityJson = await loadUserSourcePriority(user.id);
    const rankRaw = Prisma.raw(
      buildSourceRankCase(priorityJson, 'm."type"', 'm."source"'),
    );
    const typeFilter = type
      ? Prisma.sql`AND m."type" = ${type}::measurement_type`
      : Prisma.empty;
    const buckets = await prisma.$queryRaw<
      Array<{ type: string; bucket_start: Date; avg: number; cnt: number }>
    >`
      WITH canon AS (
        SELECT DISTINCT ON (m."type", date_trunc(${truncUnitLiteral}, m."measured_at"))
          m."type"                                          AS t,
          date_trunc(${truncUnitLiteral}, m."measured_at")  AS d,
          m."source"                                        AS canon
        FROM measurements m
        WHERE m."user_id" = ${user.id}
          AND m."measured_at" >= ${from}
          AND m."measured_at" <= ${to}
          AND m."deleted_at" IS NULL
          ${typeFilter}
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
      WHERE m."user_id" = ${user.id}
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        AND m."deleted_at" IS NULL
        ${typeFilter}
      GROUP BY m."type", bucket_start
      ORDER BY bucket_start ASC
      LIMIT ${cap}
    `;

    const measurements = buckets.map((b) => ({
      type: b.type,
      value: Number(b.avg),
      measuredAt: b.bucket_start.toISOString(),
      count: Number(b.cnt),
    }));
    annotate({
      action: { name: "measurement.list" },
      meta: { total: measurements.length, type, aggregate: grain },
    });
    return apiSuccess({
      measurements,
      meta: {
        total: measurements.length,
        limit: cap,
        offset: 0,
        aggregate: grain,
      },
    });
  }

  const [measurements, total] = await Promise.all([
    prisma.measurement.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: limit,
      skip: offset,
    }),
    prisma.measurement.count({ where }),
  ]);

  annotate({ action: { name: "measurement.list" }, meta: { total, type } });

  return apiSuccess({
    measurements,
    meta: { total, limit, offset },
  });
});

/**
 * v1.11.5 — per-night collapse for the SLEEP_DURATION list. Sleep is
 * stored one row per STAGE per night (minutes); a plain list leaks every
 * stage segment. This collapses the raw rows into the canonical per-night
 * shape used by the chart series + dashboard tile.
 *
 * Two modes:
 *  - `dayKey` set → drill-down: return the night's stage SEGMENTS (the
 *    canonical source's per-stage spans) so the list row can reveal the
 *    hypnogram's underlying rows, mirroring the cumulative-type drill-down.
 *  - no `dayKey` → one synthetic row per night, value = TIME ASLEEP in
 *    minutes (the canonical unit), with the per-night stage breakdown,
 *    nap count, and awakenings in the row so the UI can caption the night
 *    without a second fetch.
 *
 * The read is bounded to the last year (matching the series route's sleep
 * read) so an unbounded list never walks a multi-year per-stage row set.
 */
const SLEEP_LIST_MAX_DAYS = 365;

async function sleepListResponse(
  user: { id: string },
  opts: {
    from?: Date;
    to?: Date;
    limit: number;
    offset: number;
    sortDir: "asc" | "desc";
    dayKey?: string;
  },
) {
  const { from, to, limit, offset, sortDir, dayKey } = opts;
  const [tz, priorityJson] = await Promise.all([
    resolveUserTimezone(user.id),
    loadUserSourcePriority(user.id),
  ]);

  // Bound the read window: honour an explicit from/to, otherwise cap to
  // the last year so the per-stage scan stays small.
  const since = from ?? new Date(Date.now() - SLEEP_LIST_MAX_DAYS * 86_400_000);
  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "SLEEP_DURATION",
      deletedAt: null,
      measuredAt: {
        gte: since,
        ...(to ? { lte: to } : {}),
      },
    },
    orderBy: { measuredAt: "asc" },
    select: {
      id: true,
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      // Writer-level collapse: two HealthKit apps behind one source (watch
      // stages vs phone in-bed) must not blend into one night.
      deviceType: true,
    },
  });

  // Drill-down — return the requested night's canonical stage segments.
  if (dayKey) {
    const sessions = reconstructSleepSessions(rows, tz, priorityJson).filter(
      (s) => s.night === dayKey,
    );
    const { main, naps } = pickMainNightAndNaps(sessions);
    const dayUnit = getUnitForType("SLEEP_DURATION");
    // One row per stage segment of the main night + each nap, so the
    // drill-down reveals exactly the rows that summed into the headline.
    const segments = [main, ...naps]
      .filter((s): s is NonNullable<typeof s> => s != null)
      .flatMap((s) => s.segments);
    const measurements = segments
      .sort((a, b) =>
        sortDir === "asc"
          ? a.start.getTime() - b.start.getTime()
          : b.start.getTime() - a.start.getTime(),
      )
      .map((seg, i) => ({
        id: `sleep-seg:${dayKey}:${i}`,
        type: "SLEEP_DURATION",
        value: Math.round(seg.minutes),
        unit: dayUnit,
        source: main?.source ?? naps[0]?.source ?? "MANUAL",
        measuredAt: seg.end.toISOString(),
        sleepStage: seg.stage,
        notes: null,
      }));
    annotate({
      action: { name: "measurement.list" },
      meta: {
        total: measurements.length,
        type: "SLEEP_DURATION",
        dayKey,
        mode: "sleep-drill-down",
      },
    });
    return apiSuccess({
      measurements,
      meta: { total: measurements.length, limit, offset: 0, dayKey },
    });
  }

  // Per-night collapse — one synthetic row per wake day. The headline
  // value is the MAIN night's TIME ASLEEP (the longest session that day),
  // per the nap convention: naps are surfaced as a count, never folded
  // into the main night's headline. Reconstruct sessions and pick the
  // main + naps per wake day.
  const sessions = reconstructSleepSessions(rows, tz, priorityJson);
  const byDay = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byDay.get(s.night) ?? [];
    list.push(s);
    byDay.set(s.night, list);
  }

  const dayUnit = getUnitForType("SLEEP_DURATION");
  const nightRows: Array<{
    id: string;
    type: string;
    value: number;
    unit: string;
    source: string;
    measuredAt: string;
    notes: null;
    dayKey: string;
    sampleCount: number;
    sleepStages: Record<string, number>;
    inBedMinutes: number | null;
    awakeMinutes: number | null;
    napCount: number;
    napAsleepMinutes: number;
    awakenings: number;
  }> = [];
  for (const [day, daySessions] of byDay) {
    const { main, naps } = pickMainNightAndNaps(daySessions);
    if (!main) continue;
    nightRows.push({
      // Synthetic id mirrors the series route's `sleep:<night>` shape.
      id: `sleep:${day}`,
      type: "SLEEP_DURATION",
      value: Math.round(main.asleepMinutes),
      unit: dayUnit,
      source: main.source ?? "MANUAL",
      measuredAt: main.end.toISOString(),
      notes: null,
      dayKey: day,
      // Drives the drill-down chevron — number of stage segments behind
      // the night, matching the cumulative-type `sampleCount` contract.
      sampleCount: main.segments.length,
      sleepStages: main.stages as Record<string, number>,
      inBedMinutes: main.inBedMinutes,
      awakeMinutes: main.awakeMinutes,
      napCount: naps.length,
      napAsleepMinutes: naps.reduce((sum, n) => sum + n.asleepMinutes, 0),
      awakenings: main.awakenings,
    });
  }

  // Honour offset + limit against the full night set, and report the true
  // pre-slice night count as `meta.total` — matching the non-sleep list
  // branch's pagination contract so a client can page through nights.
  const totalNights = nightRows.length;
  const measurements = nightRows
    .sort((a, b) => {
      const cmp = a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    })
    .slice(offset, offset + limit);

  annotate({
    action: { name: "measurement.list" },
    meta: {
      total: totalNights,
      type: "SLEEP_DURATION",
      mode: "sleep-per-night",
      rowsScanned: rows.length,
    },
  });
  return apiSuccess({
    measurements,
    meta: { total: totalNights, limit, offset, groupBy: "night" },
  });
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMeasurement));

async function postMeasurement(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;

  // Batch mode (array of measurements, e.g. combined BP + Pulse)
  if (Array.isArray(body)) {
    const parsed = createBatchMeasurementSchema.safeParse({
      measurements: body,
    });
    if (!parsed.success) {
      // v1.4.43 W6 — iOS batch ingest (BP + Pulse, combined BG) needs
      // every issue echoed back so a one-shot retry can fix the full
      // payload rather than walk it field-by-field.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "measurements.create.batch.validation-failed" },
        meta: { issue_count: issues.length },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; batch
      // rows carry free-text `notes` per measurement.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "measurements.create.batch.validation-failed",
            details: JSON.stringify({ issues: auditIssues }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
    }

    const results = await prisma.$transaction(
      parsed.data.measurements.map((m) =>
        prisma.measurement.create({
          data: {
            userId: user.id,
            type: m.type as MeasurementType,
            value: m.value,
            unit: getUnitForType(m.type),
            source: (m.source ?? "MANUAL") as MeasurementSource,
            measuredAt: m.measuredAt,
            notes: m.notes ?? null,
            glucoseContext:
              (m.glucoseContext as GlucoseContext | undefined) ?? null,
            // v1.4.25 W10 reconcile (code-review M4): mirror the
            // single-entry path so the multi-entry batch persists
            // `deviceType` instead of silently dropping it.
            deviceType: m.deviceType ?? null,
          },
        }),
      ),
    );

    await auditLog("measurement.create.batch", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        count: results.length,
        types: parsed.data.measurements.map((m) => m.type),
      },
    });

    annotate({
      action: { name: "measurement.create.batch" },
      meta: {
        count: results.length,
        types: parsed.data.measurements.map((m) => m.type),
      },
    });

    // v1.4.34 IW-G — flush every cache that reflects this user's
    // measurement set so the next read paints the new rows. Interactive
    // multi-entry create (combined BP + pulse form) — hard-evict so the
    // SWR readers don't serve the pre-write body back to the user.
    invalidateUserMeasurements(user.id, { evict: true });

    // v1.18.1 — eventful Vorsorge satisfaction. Resolve the user's
    // reminders against the just-landed readings now. Fire-and-forget.
    void enqueueReminderSatisfy(user.id).catch(() => {});

    // v1.5.0 — refresh the persistent rollup table for every distinct
    // (type, day) the batch touched so the next analytics / coach read
    // hits the cache rather than falling through to live aggregation.
    // Collapsed by day so a multi-entry batch on the same morning fires
    // one DAY recompute per type instead of one per row. Best-effort
    // — a populator hiccup never fails the user's write.
    try {
      const keys = collapseToTypeDayKeys(
        results.map((r) => ({ type: r.type, measuredAt: r.measuredAt })),
      );
      for (const k of keys) {
        await recomputeBucketsForMeasurement(user.id, k.type, k.measuredAt);
      }

      // v1.8.0 — drop the cached per-metric assessment rows the ingested
      // types dirty so the next mount / nightly warm pass regenerates
      // them against the new data. Fire-and-forget: never blocks ingest.
      invalidateStatusInsightsForTypes(
        user.id,
        keys.map((k) => k.type),
      ).catch((err) => {
        console.warn("[measurements] status-insight invalidate failed", err);
      });
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }

    return apiSuccess(results, 201);
  }

  // Single mode (existing behavior)
  const parsed = createMeasurementSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 W6 — single-row POST is the iOS fallback path; one
    // round-trip per stale-field bug was the v1.4.41 iOS-contract
    // pain point. Multi-issue envelope + audit breadcrumb.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "measurements.create.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; single
    // measurement carries free-text `notes`.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    prisma.auditLog
      .create({
        data: {
          userId: user.id,
          action: "measurements.create.validation-failed",
          details: JSON.stringify({ issues: auditIssues }),
        },
      })
      .catch(() => {
        /* swallow — 422 response is the contract */
      });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { type, value, measuredAt, notes, source, glucoseContext, deviceType } =
    parsed.data;

  // Handle unique constraint violation
  let measurement;
  try {
    measurement = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: type as MeasurementType,
        value,
        unit: getUnitForType(type),
        source: (source ?? "MANUAL") as MeasurementSource,
        measuredAt,
        notes: notes ?? null,
        glucoseContext: (glucoseContext as GlucoseContext | undefined) ?? null,
        // v1.4.25 W10 reconcile (code-review M4): the deviceType column
        // already accepts client metadata from the batch route. Mirror
        // the behaviour here so single-entry POST persists the tag
        // instead of silently dropping it.
        deviceType: deviceType ?? null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return apiError("A measurement with this data already exists", 409);
    }
    throw err;
  }

  await auditLog("measurement.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { type, measurementId: measurement.id },
  });

  annotate({
    action: {
      name: "measurement.create",
      entity_type: "measurement",
      entity_id: measurement.id,
    },
  });

  // v1.4.34 IW-G — flush every cache that reflects this user's
  // measurement set so the next read paints the new row. Interactive
  // single-entry create — hard-evict so the SWR readers don't serve the
  // pre-write body back to the user.
  invalidateUserMeasurements(user.id, { evict: true });

  // v1.18.1 — eventful Vorsorge satisfaction. Resolve the user's reminders
  // against the just-landed reading now. Fire-and-forget.
  void enqueueReminderSatisfy(user.id).catch(() => {});

  // v1.5.0 — refresh the persistent rollup row for the affected
  // (type, day) tuple. Runs inline so the next read of the
  // comprehensive / analytics surface is correct without waiting on
  // pg-boss; WEEK / MONTH / YEAR recomputes are enqueued under the
  // hood. Best-effort — a populator hiccup never fails the user's
  // write.
  try {
    await recomputeBucketsForMeasurement(
      user.id,
      measurement.type,
      measurement.measuredAt,
    );
  } catch (err) {
    console.warn("[measurements] rollup recompute failed", err);
  }

  // v1.8.0 — drop the cached per-metric assessment rows this type
  // dirties so the next mount / nightly warm pass regenerates against
  // the new row. Fire-and-forget: never blocks the user's write.
  invalidateStatusInsightsForTypes(user.id, [measurement.type]).catch((err) => {
    console.warn("[measurements] status-insight invalidate failed", err);
  });

  return apiSuccess(measurement, 201);
}
