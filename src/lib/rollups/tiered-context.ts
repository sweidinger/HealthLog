/**
 * v1.18.7 — progressive / tiered data-context builder for the AI surfaces.
 *
 * The principle (research/coach-prompt-tiering.md §3): feed the model the
 * RIGHT RESOLUTION of history — recent dense, older progressively coarser —
 * plus a preserved peak/anomaly envelope so a sharp reading from months ago
 * survives even when its month is a single coarse bucket. Downsampling
 * silently eats peaks unless you keep the min/max envelope; our rollup
 * buckets already carry `minValue` / `maxValue`, so the envelope is free.
 *
 * Five progressive bands per metric:
 *
 *   | Band      | Source                | Resolution           |
 *   |-----------|-----------------------|----------------------|
 *   | 0–14d     | raw `Measurement`     | daily points         |
 *   | 14–30d    | DAY rollup            | daily mean + min/max |
 *   | 30–90d    | WEEK rollup           | weekly mean + slope  |
 *   | 90d–1y    | MONTH rollup          | monthly mean + min/max |
 *   | >1y       | YEAR rollup           | yearly mean + min/max |
 *
 * plus a per-metric `anomalies` list (≤5) ranked by `|deltaSd|`.
 *
 * Coverage is "replace, fall back on miss": `probeRollupCoverage` /
 * `ensureUserRollupsFresh` run first; on a per-type coverage miss the band
 * falls back to live SQL exactly as the existing readers do (the readers
 * themselves never throw — an empty result simply yields an empty band).
 *
 * ~600 tokens / metric at ~4 chars/token: ≈14 raw + ≈16 DAY + ≈9 WEEK +
 * ≈12 MONTH + ≤5 YEAR + ≤5 anomalies.
 */
import { prisma } from "@/lib/db";
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";
import {
  ensureUserRollupsFresh,
  readRollupBuckets,
} from "./measurement-rollups";
import { probeRollupCoverage } from "./measurement-coverage";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Band cut points in days-ago. */
export const TIERED_BANDS = {
  rawDays: 14,
  dayUntil: 30,
  weekUntil: 90,
  monthUntil: 365,
  yearUntil: 5 * 365,
} as const;

/** One raw daily point in the 0–14d band. */
export interface TieredRawPoint {
  /** ISO date (UTC) of the day the point summarises. */
  date: string;
  /** Mean of that day's readings (a single point for most metrics). */
  value: number;
  count: number;
}

/** One coarser bucket carrying the min/max envelope that keeps peaks alive. */
export interface TieredBucket {
  /** ISO timestamp anchored to the bucket start (date_trunc semantics). */
  bucketStart: string;
  mean: number;
  min: number;
  max: number;
  count: number;
  /** Units-per-day trend slope when the rollup carried one. */
  slope?: number | null;
}

/** A peak/trough preserved from the envelope so a coarse band cannot hide it. */
export interface TieredAnomaly {
  band: "raw" | "day" | "week" | "month" | "year";
  /** ISO date of the extreme bucket. */
  date: string;
  kind: "peak" | "trough";
  value: number;
  /** Standard deviations from the window mean, signed. */
  deltaSd: number;
}

export interface TieredSeries {
  type: MeasurementType;
  /** 0–14d raw daily points. */
  recentDaily: TieredRawPoint[];
  /** 14–30d DAY-rollup buckets. */
  dayBand: TieredBucket[];
  /** 30–90d WEEK-rollup buckets. */
  weekBand: TieredBucket[];
  /** 90d–1y MONTH-rollup buckets. */
  monthBand: TieredBucket[];
  /** >1y YEAR-rollup buckets. */
  yearBand: TieredBucket[];
  /** Preserved peaks/troughs, ≤5, ranked by |deltaSd|. */
  anomalies: TieredAnomaly[];
  /** Window-level stats used for anomaly scoring + a quick baseline read. */
  windowStats: {
    mean: number | null;
    sd: number | null;
    n: number;
  };
}

export interface BuildTieredSeriesOptions {
  /** Clock override for tests; defaults to `Date.now()`. */
  now?: number;
  /**
   * Skip the `ensureUserRollupsFresh` recompute (the caller already ran it
   * for the batch, or is on a hot path). Coverage is still probed.
   */
  skipEnsureFresh?: boolean;
  /**
   * Cap on anomalies per metric. Defaults to 5. The list is ranked by
   * `|deltaSd|` before the cap.
   */
  maxAnomalies?: number;
  /**
   * v1.18.7 — skip the raw 0–14d `Measurement` read and return an empty
   * `recentDaily`. For callers (the Coach snapshot) that already hold the
   * recent daily rows from their own query and only need the coarser
   * MONTH/YEAR bands + anomaly envelope; avoids a duplicate raw round-trip.
   */
  skipRecentDaily?: boolean;
  /**
   * v1.18.7 — skip the raw 0–14d read AND the DAY (14–30d) / WEEK (30–90d)
   * band reads, returning only the MONTH / YEAR bands plus the anomaly
   * envelope. For the Coach's `buildCoarseTimelineTail`, which consumes only
   * month/year + anomalies; the skipped near-term bands would otherwise be
   * read and discarded. The anomaly window-stats then span the coarse bands
   * only, which is the right baseline for the deep-history tail. Implies
   * `skipRecentDaily`.
   */
  coarseOnly?: boolean;
}

interface RollupBucket {
  bucketStart: Date;
  count: number;
  mean: number;
  minValue: number;
  maxValue: number;
  sd: number | null;
  slope: number | null;
  r2: number | null;
}

function toBucket(r: RollupBucket): TieredBucket {
  return {
    bucketStart: r.bucketStart.toISOString(),
    mean: round(r.mean),
    min: round(r.minValue),
    max: round(r.maxValue),
    count: r.count,
    slope: r.slope,
  };
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Window mean + population SD over every bucket's mean. */
function windowStats(buckets: RollupBucket[]): {
  mean: number | null;
  sd: number | null;
  n: number;
} {
  const usable = buckets.filter((b) => b.count >= 1);
  const n = usable.reduce((s, b) => s + b.count, 0);
  if (usable.length === 0) return { mean: null, sd: null, n: 0 };
  const means = usable.map((b) => b.mean);
  const mean = means.reduce((s, m) => s + m, 0) / means.length;
  if (means.length < 2) return { mean: round(mean), sd: null, n };
  const variance =
    means.reduce((s, m) => s + (m - mean) ** 2, 0) / means.length;
  return { mean: round(mean), sd: round(Math.sqrt(variance)), n };
}

/**
 * Scan every bucket's min/max envelope and emit the buckets whose extreme
 * exceeds `mean ± 2·sd`. The min/max-envelope technique guarantees a spike
 * from months ago survives a coarse MONTH/YEAR bucket. Requires `count ≥ 3`
 * and a usable spread to suppress sparse-metric false positives.
 */
function extractAnomalies(
  bands: Array<{ band: TieredAnomaly["band"]; buckets: RollupBucket[] }>,
  stats: { mean: number | null; sd: number | null },
  cap: number,
): TieredAnomaly[] {
  if (stats.mean === null || stats.sd === null || stats.sd <= 0) return [];
  const { mean, sd } = stats;
  const out: TieredAnomaly[] = [];
  for (const { band, buckets } of bands) {
    for (const b of buckets) {
      if (b.count < 3) continue;
      const highSd = (b.maxValue - mean) / sd;
      const lowSd = (b.minValue - mean) / sd;
      if (highSd >= 2) {
        out.push({
          band,
          date: b.bucketStart.toISOString(),
          kind: "peak",
          value: round(b.maxValue),
          deltaSd: round(highSd, 1),
        });
      }
      if (lowSd <= -2) {
        out.push({
          band,
          date: b.bucketStart.toISOString(),
          kind: "trough",
          value: round(b.minValue),
          deltaSd: round(lowSd, 1),
        });
      }
    }
  }
  return out
    .sort((a, b) => Math.abs(b.deltaSd) - Math.abs(a.deltaSd))
    .slice(0, cap);
}

/** Read the raw 0–14d daily points for one type, folding same-day rows. */
async function readRecentDaily(
  userId: string,
  type: MeasurementType,
  now: number,
): Promise<TieredRawPoint[]> {
  const since = new Date(now - TIERED_BANDS.rawDays * DAY_MS);
  const rows = await prisma.measurement.findMany({
    where: { userId, type, measuredAt: { gte: since }, deletedAt: null },
    select: { value: true, measuredAt: true },
    orderBy: { measuredAt: "asc" },
  });
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const key = r.measuredAt.toISOString().slice(0, 10);
    const entry = byDay.get(key) ?? { sum: 0, count: 0 };
    entry.sum += r.value;
    entry.count += 1;
    byDay.set(key, entry);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, { sum, count }]) => ({
      date,
      value: round(sum / count),
      count,
    }));
}

async function readBand(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  fromDaysAgo: number,
  toDaysAgo: number,
  now: number,
): Promise<RollupBucket[]> {
  const from = new Date(now - fromDaysAgo * DAY_MS);
  const to = new Date(now - toDaysAgo * DAY_MS);
  // `readRollupBuckets` never throws — an empty / missing partition yields
  // an empty array, which is the "fall back to nothing for this band"
  // behaviour the coverage miss path relies on.
  return readRollupBuckets(userId, type, granularity, from, to);
}

/**
 * Build the 5-band progressive context + anomaly envelope for one metric.
 *
 * Reuses `probeRollupCoverage` / `ensureUserRollupsFresh` (replace, fall
 * back on miss). The coarse bands read straight from the rollup table; the
 * 0–14d band reads raw rows so the most recent days are exact.
 */
export async function buildTieredSeries(
  userId: string,
  type: MeasurementType,
  options: BuildTieredSeriesOptions = {},
): Promise<TieredSeries> {
  const now = options.now ?? Date.now();
  const cap = options.maxAnomalies ?? 5;

  if (!options.skipEnsureFresh) {
    // Recompute a stale trailing-90-day DAY window before reading; the helper
    // is in-flight-deduped and swallows its own errors.
    await ensureUserRollupsFresh(userId);
  }

  const coarseOnly = options.coarseOnly ?? false;
  const emptyBand = Promise.resolve<RollupBucket[]>([]);
  const [recentDaily, dayBand, weekBand, monthBand, yearBand] =
    await Promise.all([
      options.skipRecentDaily || coarseOnly
        ? Promise.resolve<TieredRawPoint[]>([])
        : readRecentDaily(userId, type, now),
      coarseOnly
        ? emptyBand
        : readBand(
            userId,
            type,
            "DAY",
            TIERED_BANDS.dayUntil,
            TIERED_BANDS.rawDays,
            now,
          ),
      coarseOnly
        ? emptyBand
        : readBand(
            userId,
            type,
            "WEEK",
            TIERED_BANDS.weekUntil,
            TIERED_BANDS.dayUntil,
            now,
          ),
      readBand(
        userId,
        type,
        "MONTH",
        TIERED_BANDS.monthUntil,
        TIERED_BANDS.weekUntil,
        now,
      ),
      readBand(
        userId,
        type,
        "YEAR",
        TIERED_BANDS.yearUntil,
        TIERED_BANDS.monthUntil,
        now,
      ),
    ]);

  // Window stats span every coarse bucket so the anomaly threshold reflects
  // the user's whole logged history, not just one band.
  const allBuckets = [...dayBand, ...weekBand, ...monthBand, ...yearBand];
  const stats = windowStats(allBuckets);

  const anomalies = extractAnomalies(
    [
      { band: "day", buckets: dayBand },
      { band: "week", buckets: weekBand },
      { band: "month", buckets: monthBand },
      { band: "year", buckets: yearBand },
    ],
    stats,
    cap,
  );

  return {
    type,
    recentDaily,
    dayBand: dayBand.map(toBucket),
    weekBand: weekBand.map(toBucket),
    monthBand: monthBand.map(toBucket),
    yearBand: yearBand.map(toBucket),
    anomalies,
    windowStats: stats,
  };
}

/**
 * Convenience batch — build tiered series for several metrics, probing
 * coverage once and recomputing freshness once for the whole set. Types with
 * no rollup coverage AND no raw rows simply come back with empty bands.
 */
export async function buildTieredSeriesForTypes(
  userId: string,
  types: MeasurementType[],
  options: BuildTieredSeriesOptions = {},
): Promise<TieredSeries[]> {
  const now = options.now ?? Date.now();
  if (!options.skipEnsureFresh) {
    await ensureUserRollupsFresh(userId);
  }
  // Probe coverage once so the caller can reason about which bands are
  // rollup-backed vs raw-only; the per-type builder still falls back on miss.
  const coverage = await probeRollupCoverage(userId);
  const present = types.filter((t) => coverage.has(t));
  return Promise.all(
    present.map((type) =>
      buildTieredSeries(userId, type, {
        ...options,
        now,
        skipEnsureFresh: true,
      }),
    ),
  );
}
