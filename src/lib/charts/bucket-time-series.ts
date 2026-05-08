/**
 * Time-series bucketing for the health-chart visualisation.
 *
 * The dashboard charts default to daily points, but on a multi-year
 * range that produces hundreds or thousands of dots that the eye
 * cannot read. v1.4.6 introduces automatic aggregation so the user
 * still sees the trend without paying the rendering cost:
 *
 *   - range ≤ 90 days  → "day"   (no change, daily points)
 *   - range 91-730     → "week"  (ISO weekly mean per metric)
 *   - range > 730 days → "month" (Berlin calendar monthly mean)
 *
 * The function is pure and string-stable: the bucket key for a given
 * timestamp depends only on the calendar week / month, never on the
 * input order, so the chart-data adapter can call it as part of its
 * memoised render path without surprise.
 */

export type ChartBucketType = "day" | "week" | "month";

export interface ChartBucketPoint {
  /** Berlin TZ start-of-bucket as a Unix ms timestamp. */
  timestamp: number;
  /**
   * The mean value per metric. Days/weeks/months without an
   * observation are skipped entirely — never reported as 0.
   */
  values: Record<string, number>;
  /** How many daily input points fed into this bucket per metric. */
  counts: Record<string, number>;
}

export interface BucketedChartSeries {
  bucket: ChartBucketType;
  points: ChartBucketPoint[];
}

const BERLIN_TZ = "Europe/Berlin";

const BERLIN_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: BERLIN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface BerlinYmd {
  year: number;
  month: number;
  day: number;
}

function toBerlinYmd(date: Date): BerlinYmd {
  const parts = BERLIN_FMT.formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  if (!year || !month || !day) {
    throw new Error("Could not derive Berlin Y-M-D");
  }
  return { year, month, day };
}

function utcMidnight({ year, month, day }: BerlinYmd): number {
  return Date.UTC(year, month - 1, day);
}

/**
 * ISO 8601 week starts on Monday. Week 1 of a year is the week
 * containing the first Thursday of that year. Returns the UTC
 * midnight of the Monday of the week containing `date`.
 */
function isoWeekStartUtc(date: Date): number {
  const ymd = toBerlinYmd(date);
  const utc = utcMidnight(ymd);
  // Day of week, 1=Mon..7=Sun (ISO).
  const dow = ((new Date(utc).getUTCDay() + 6) % 7) + 1;
  return utc - (dow - 1) * MS_PER_DAY;
}

function monthStartUtc(date: Date): number {
  const { year, month } = toBerlinYmd(date);
  return Date.UTC(year, month - 1, 1);
}

function dayStartUtc(date: Date): number {
  return utcMidnight(toBerlinYmd(date));
}

export interface BucketInputPoint {
  /**
   * Either a Date or a unix-ms number. Daily aggregations from the
   * health-chart adapter come in as numbers; raw API rows come in as
   * Date.
   */
  timestamp: number | Date;
  /** Per-metric value map (same keys as the chart series). */
  values: Record<string, number | undefined>;
}

export interface BucketTimeSeriesOptions {
  /** Override the bucketer when the caller already knows it. */
  bucket?: ChartBucketType;
}

/**
 * Pick the bucket size from a time-range in days.
 */
export function pickBucket(rangeDays: number): ChartBucketType {
  if (rangeDays > 730) return "month";
  if (rangeDays > 90) return "week";
  return "day";
}

/**
 * Bucket a daily-aggregated chart series into day/week/month groups.
 * Weeks use ISO 8601 (Monday start); months use Berlin calendar.
 * Empty buckets are skipped so a sparse user does not get a flat zero
 * baseline.
 */
export function bucketTimeSeries(
  points: BucketInputPoint[],
  options: BucketTimeSeriesOptions = {},
): BucketedChartSeries {
  const sorted = [...points].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));

  const bucket =
    options.bucket ??
    pickBucket(
      sorted.length < 2
        ? 0
        : Math.round(
            (toMs(sorted[sorted.length - 1].timestamp) -
              toMs(sorted[0].timestamp)) /
              MS_PER_DAY,
          ),
    );

  if (bucket === "day") {
    // Day-granularity is the upstream's native shape, but we still go
    // through aggregation so the output shape is consistent and so
    // duplicate-day callers (raw API mode) collapse cleanly.
    return aggregate(sorted, bucket, (ts) => dayStartUtc(new Date(toMs(ts))));
  }
  if (bucket === "week") {
    return aggregate(sorted, bucket, (ts) =>
      isoWeekStartUtc(new Date(toMs(ts))),
    );
  }
  return aggregate(sorted, bucket, (ts) => monthStartUtc(new Date(toMs(ts))));
}

function toMs(ts: number | Date): number {
  return typeof ts === "number" ? ts : ts.getTime();
}

function aggregate(
  points: BucketInputPoint[],
  bucket: ChartBucketType,
  bucketKey: (timestamp: number | Date) => number,
): BucketedChartSeries {
  const aggregates = new Map<
    number,
    { sums: Record<string, number>; counts: Record<string, number> }
  >();

  for (const point of points) {
    const key = bucketKey(point.timestamp);
    const slot = aggregates.get(key) ?? { sums: {}, counts: {} };
    for (const [metric, raw] of Object.entries(point.values)) {
      if (raw === undefined || !Number.isFinite(raw)) continue;
      slot.sums[metric] = (slot.sums[metric] ?? 0) + (raw as number);
      slot.counts[metric] = (slot.counts[metric] ?? 0) + 1;
    }
    aggregates.set(key, slot);
  }

  const out: ChartBucketPoint[] = Array.from(aggregates.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, slot]) => {
      const values: Record<string, number> = {};
      const counts: Record<string, number> = {};
      for (const [metric, sum] of Object.entries(slot.sums)) {
        const n = slot.counts[metric] ?? 0;
        if (n === 0) continue;
        values[metric] = sum / n;
        counts[metric] = n;
      }
      return { timestamp, values, counts };
    })
    .filter((p) => Object.keys(p.values).length > 0);

  return { bucket, points: out };
}
