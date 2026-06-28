/**
 * Feature extraction for OpenAI insights.
 * Extracts aggregated health metrics from the database.
 * No raw timestamps or exact values are sent in aggregated mode.
 */
import { prisma } from "@/lib/db";
import { summarize, trendSlope } from "@/lib/analytics/trends";
import type { DataPoint } from "@/lib/analytics/trends";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  pairByTimestamp,
  pearsonCorrelation,
  type CorrelationResult,
} from "@/lib/analytics/correlations";
import { getMedicationCategories } from "@/lib/medication-category";
import { classifyReferenceRange } from "@/lib/labs/reference-range";
import { resolveLabFields } from "@/lib/labs/serialise";
import { readRollupBuckets } from "@/lib/rollups/measurement-rollups";
import { deriveBucketedTypes } from "@/lib/signals/adapters/correlation";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";

interface DataCoverage {
  count: number;
  spanDays: number;
  avgDaysBetween: number | null;
  oldestDaysAgo: number;
  newestDaysAgo: number;
}

export interface AggregatedFeatures {
  weight?: {
    latest: number;
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    allTimeAvg: number | null;
    allTimeMin: number | null;
    allTimeMax: number | null;
    slope30: number | null;
    outlierCount: number;
    bmi: number | null;
    coverage: DataCoverage;
  };
  bloodPressure?: {
    avgSys30: number | null;
    avgDia30: number | null;
    avgSys90: number | null;
    avgDia90: number | null;
    allTimeAvgSys: number | null;
    allTimeAvgDia: number | null;
    allTimeMinSys: number | null;
    allTimeMaxSys: number | null;
    allTimeMinDia: number | null;
    allTimeMaxDia: number | null;
    slopeSys30: number | null;
    slopeDia30: number | null;
    sdSys30: number | null;
    sdDia30: number | null;
    pulsePressure30: number | null;
    pctInTarget: number | null;
    coverage: DataCoverage;
  };
  pulse?: {
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    allTimeAvg: number | null;
    allTimeMin: number | null;
    allTimeMax: number | null;
    slope30: number | null;
    anomalyCount: number;
    coverage: DataCoverage;
  };
  bodyFat?: {
    latest: number | null;
    avg30: number | null;
    slope30: number | null;
    coverage: DataCoverage;
  };
  mood?: {
    scale: string;
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    trend30: "improving" | "declining" | "stable" | null;
    totalEntries: number;
    coverage: DataCoverage;
  };
  sleep?: {
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    coverage: DataCoverage;
  };
  activity?: {
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    coverage: DataCoverage;
  };
  ratePressureProduct?: {
    rpp7: number | null;
    rpp30: number | null;
    risk: "normal" | "elevated" | null;
  };
  bodyCompositionDivergence?: {
    weightStable: boolean;
    bodyFatRising: boolean;
    flag: boolean;
  };
  moodAdherenceRisk?: boolean;
  seasonalVariation?: {
    winterAvgSys: number | null;
    summerAvgSys: number | null;
    delta: number | null;
    significance: "normal" | "elevated" | null;
  };
  correlations?: {
    weightVsSystolic: CorrelationResult | null;
    weightVsDiastolic: CorrelationResult | null;
    pulseVsSystolic: CorrelationResult | null;
    moodVsPulse: CorrelationResult | null;
    moodVsSystolic: CorrelationResult | null;
    moodVsWeight: CorrelationResult | null;
    sleepVsPulse: CorrelationResult | null;
    sleepVsSystolic: CorrelationResult | null;
  };
  historicalComparison?: {
    weight?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    systolic?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    diastolic?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    pulse?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
  };
  medications?: Array<{
    name: string;
    dose: string;
    category: string;
    compliance7: number;
    compliance30: number;
    compliance90: number;
    streak: number;
    missedLast7: number;
  }>;
  context: {
    heightCm: number | null;
    hasBpTargets: boolean;
    totalMeasurements: number;
    dataSpanDays: number;
    oldestMeasurementDaysAgo: number | null;
    newestMeasurementDaysAgo: number | null;
    ageYears: number | null;
    gender: string | null;
  };
  /**
   * v1.18.7 — "Signals of the day": the present-focused read the daily
   * briefing leads with. Each entry compares the freshest reading against
   * the user's own trailing-7d / 30d windows, flags an emerging slope, and
   * surfaces a recent anomaly — ranked by clinical priority, ≤3 entries.
   *
   * Recomputed every day: the freshest reading, the 7/30d windows, and the
   * recency move daily, so a flat 30/90d mean no longer pins the briefing.
   * The block lands inside the compacted features payload, so it also seeds
   * the content-hash gate (`hashInsightSnapshot`) — a fresh daily signal
   * forces the briefing to regenerate. See `computeSignalsOfDay`.
   */
  signalsOfDay?: SignalOfDay[];
  /**
   * v1.22 — glucose aggregate block. Glucose previously reached the briefing
   * only as a single `signalOfDay` row; this is the present-and-trend block the
   * other vitals already carry (7 / 30 / 90-day means + a 30-day slope), from
   * the canonical stored value. Omitted when the user has no glucose readings.
   */
  glucose?: {
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    latest: number | null;
    latestDaysAgo: number | null;
    slope30: number | null;
    coverage: DataCoverage;
  };
  /**
   * v1.22 — recent FLAGGED biomarkers (abnormal or trending). Closes the
   * biggest siloed domain: labs reached the Coach snapshot but never the
   * briefing. Hidden biomarkers (the W3 catalog `hidden` flag) are excluded;
   * qualitative rows carry a neutral `unknown` status (no fabricated verdict).
   * Only abnormal / trending markers surface (the briefing-relevant ones) and
   * the list is bounded. Omitted when nothing is flagged.
   */
  labs?: {
    flagged: Array<{
      analyte: string;
      value: number | null;
      valueText: string | null;
      unit: string;
      rangeStatus: "in-range" | "below" | "above" | "unknown";
      /** Direction vs the immediately prior reading; null without a prior. */
      trend: "rising" | "falling" | "flat" | null;
      takenAt: string;
      daysAgo: number;
    }>;
    /** Count of flagged markers (may exceed the bounded `flagged` length). */
    flaggedCount: number;
  };
  /**
   * v1.22 — preventive-care (Vorsorge) read-side: due + overdue items. The
   * early-nudge use case ("your screening is overdue"). Previously fully siloed
   * — captured + scheduled but read by no AI surface. Labels are sanitised
   * (user free-text). Omitted when nothing is due or overdue.
   */
  preventiveCare?: {
    overdue: Array<{ label: string; daysOverdue: number }>;
    due: Array<{ label: string; daysUntil: number }>;
  };
  /**
   * v1.22 — workout aggregate. The briefing previously saw activity only as
   * ACTIVITY_STEPS; the `Workout` table never reached it. Provider-agnostic
   * counts + load over the trailing windows. Omitted when no workouts logged.
   */
  workouts?: {
    last7: {
      count: number;
      totalDurationMin: number;
      totalDistanceKm: number | null;
    };
    last30: {
      count: number;
      totalDurationMin: number;
      totalDistanceKm: number | null;
    };
    latest: {
      sportType: string;
      daysAgo: number;
      durationMin: number;
      distanceKm: number | null;
    } | null;
  };
}

/**
 * v1.18.7 — one present-focused signal feeding the daily briefing. Every
 * numeric field is pre-computed so the model states it rather than
 * re-deriving the comparison (which small LLMs do unreliably).
 */
export interface SignalOfDay {
  /** Briefing `sourceMetric` discriminator the UI pins an icon + route on. */
  metric:
    | "bp"
    | "weight"
    | "pulse"
    | "mood"
    | "sleep"
    | "resting_hr"
    | "glucose";
  /** Natural-language label (no enum leak into prose). */
  label: string;
  /** Unit string when the metric carries one. */
  unit?: string;
  /** Freshest reading (the "now" value the briefing leads with). */
  latest: number;
  /** Days since the freshest reading. */
  latestDaysAgo: number;
  /** Trailing-7d mean. */
  avg7: number | null;
  /** Trailing-30d mean. */
  avg30: number | null;
  /** Signed `latest − avg7`, pre-computed. */
  deltaVs7: number | null;
  /** Signed `latest − avg30`, pre-computed. */
  deltaVs30: number | null;
  /** Normal-swing SD over the trailing-30d window. */
  spread30: number | null;
  /** `|latest − avg30| > spread30` — the significance verdict as a boolean. */
  outsideNormalSwing: boolean;
  /** Emerging direction over the trailing 30 days (slope sign). */
  emergingTrend: "rising" | "falling" | "flat" | null;
  /** A peak / trough inside the last 14 days, when one stands out. */
  recentAnomaly: {
    kind: "peak" | "trough";
    value: number;
    anomalyDaysAgo: number;
  } | null;
}

/**
 * One bucketed series. `granularity` decides the bucket width (DAY for
 * the trailing 90-day window, WEEK for 90→365 days, MONTH for the
 * 365→1825-day deep history). `bucketStart` is an ISO-8601 UTC
 * timestamp anchored to the start of the bucket — Postgres
 * `date_trunc()` semantics, same as the rollup populator.
 *
 * Replaces v1.4.35.x `rawMeasurements` (which appended every
 * measurement row and blew the 10 MB Codex prompt ceiling on power
 * users with multi-year imports — 25.9 MB observed on the maintainer's account
 * with 311 775 rows). Reading from `measurement_rollups` instead caps
 * the payload at O(types × buckets) regardless of underlying row
 * count.
 */
export interface BucketedSeries {
  type: string;
  granularity: RollupGranularity;
  buckets: Array<{
    bucketStart: string;
    mean: number;
    count: number;
  }>;
}

export interface RawFeatures extends AggregatedFeatures {
  bucketedMeasurements: BucketedSeries[];
}

/**
 * v1.4.36 W3 T1 — payload size ceiling. The Codex provider rejects
 * any prompt-string above 10 MB; the features payload is roughly half
 * the eventual prompt (the JSON dump plus the system + comparison
 * blocks), so a 5 MB feature payload sits comfortably below the
 * ceiling even after locale-prefix expansion. Throwing here lets the
 * route handler downgrade to the non-raw payload + annotate so we
 * catch the regression instead of blowing the upstream call.
 */
export const FEATURES_MAX_BYTES = 5 * 1024 * 1024;

/**
 * v1.18.11 P1 — default bounded read window for the comprehensive briefing.
 *
 * The briefing's prose only ever cites 7 / 30 / 90-day windows plus all-time
 * extremes; the unbounded `measurement.findMany` it used to run materialised
 * the entire history (tens to hundreds of thousands of rows for multi-year
 * Withings / Apple imports) into JS on every generation, only to trim the
 * payload after the fact through the 5 MB downgrade ladder. 400 days captures
 * full history for the overwhelming majority of accounts while keeping the
 * seasonal-BP contrast (winter vs summer, needs >180 d) intact; the genuinely
 * long-horizon all-time min/max/avg figures are sourced separately from a
 * single grouped aggregation over the whole history (see
 * `readAllTimeExtremes`), so bounding the bulk read does not silently relabel a
 * 400-day extreme as "all-time". Mirrors the Coach's 90-day bound
 * (`coach/snapshot.ts`), just wider because the briefing narrates longer trends.
 */
export const BRIEFING_FEATURE_WINDOW_DAYS = 400;

/** All-time aggregate (full history) for one measurement type. */
interface AllTimeExtremes {
  mean: number | null;
  min: number | null;
  max: number | null;
}

/**
 * v1.18.11 P1 — full-history min / max / mean per measurement type via ONE
 * grouped SQL aggregation, with NO row materialisation in JS. Used to fill the
 * `allTime*` feature fields honestly when the bulk feature read is bounded to a
 * recent window: the windowed `summarize()` covers trends + recent windows, and
 * this covers the long-horizon extremes the prompt labels "allTime".
 *
 * Only the four types that expose `allTime*` fields are aggregated (weight,
 * systolic, diastolic, pulse). Returns a map keyed by `MeasurementType`; a type
 * with no rows is simply absent.
 */
async function readAllTimeExtremes(
  userId: string,
  types: readonly MeasurementType[],
): Promise<Map<MeasurementType, AllTimeExtremes>> {
  const rows = await prisma.measurement.groupBy({
    by: ["type"],
    where: { userId, deletedAt: null, type: { in: [...types] } },
    _avg: { value: true },
    _min: { value: true },
    _max: { value: true },
  });
  const out = new Map<MeasurementType, AllTimeExtremes>();
  for (const r of rows) {
    out.set(r.type, {
      mean: r._avg.value ?? null,
      min: r._min.value ?? null,
      max: r._max.value ?? null,
    });
  }
  return out;
}

/** Round an all-time mean to 1 decimal, matching the windowed `summarize` mean. */
function roundMean(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

export class FeaturesPayloadTooLargeError extends Error {
  readonly code = "FEATURES_PAYLOAD_TOO_LARGE";
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `Features payload too large: ${sizeBytes} bytes exceeds ${limitBytes} byte cap`,
    );
    this.name = "FeaturesPayloadTooLargeError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * v1.4.36 W3 T1 — bucket-window definitions for the
 * `bucketedMeasurements` payload. Mirrors the rollup populator's
 * granularity ladder so the read-side picks up whatever the persistent
 * table holds without a recompute round-trip.
 *
 * The 90 / 365 / 1825-day windows are non-overlapping: each row of
 * `measurement_rollups` lives at exactly one granularity, and the
 * downstream model reads the union of the three series per type.
 * Total volume per type for a heavy power user (5 years of daily
 * data): 90 DAY + 39 WEEK + 50 MONTH = 179 buckets × ~40 bytes JSON
 * each ≈ 7 KB. Eight metric types lands at ~56 KB — well under the
 * 5 MB cap above, vs 25.9 MB for the v1.4.35 rawMeasurements shape.
 */
const BUCKET_WINDOWS: Array<{
  granularity: RollupGranularity;
  fromDays: number;
  toDays: number;
}> = [
  { granularity: "DAY", fromDays: 0, toDays: 90 },
  { granularity: "WEEK", fromDays: 90, toDays: 365 },
  { granularity: "MONTH", fromDays: 365, toDays: 1825 },
];

/**
 * Types the bucketed payload covers. Mirrors the aggregate branches
 * above so the model never sees a bucket for a metric whose aggregate
 * block was suppressed. New `MeasurementType` enum values flow in by
 * adding one row; the rollup populator already covers every type.
 */
// Derived from the signal registry: every signal flagged
// `surfaces.correlationEligible` projects to its DB `MeasurementType`. The list
// is a membership/iteration set (each type is read independently), so order is
// not significant; the registry-invariant test pins the set byte-for-byte.
const BUCKETED_TYPES: MeasurementType[] = deriveBucketedTypes();

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

function toDataPoints(
  records: Array<{ value: number; measuredAt: Date }>,
): DataPoint[] {
  return records.map((r) => ({ date: r.measuredAt, value: r.value }));
}

function computeCoverage(
  records: Array<{ measuredAt: Date }>,
  now: number,
): DataCoverage {
  if (records.length === 0) {
    return {
      count: 0,
      spanDays: 0,
      avgDaysBetween: null,
      oldestDaysAgo: 0,
      newestDaysAgo: 0,
    };
  }
  const oldest = records[0].measuredAt.getTime();
  const newest = records[records.length - 1].measuredAt.getTime();
  const spanDays = Math.round((newest - oldest) / (24 * 60 * 60 * 1000));
  const avgDaysBetween =
    records.length > 1
      ? Math.round((spanDays / (records.length - 1)) * 10) / 10
      : null;
  return {
    count: records.length,
    spanDays,
    avgDaysBetween,
    oldestDaysAgo: Math.round((now - oldest) / (24 * 60 * 60 * 1000)),
    newestDaysAgo: Math.round((now - newest) / (24 * 60 * 60 * 1000)),
  };
}

/** Compute average of values within a time window (days ago from now). */
function avgInWindow(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  fromDaysAgo: number,
  toDaysAgo: number = 0,
): number | null {
  const fromMs = now - fromDaysAgo * 24 * 60 * 60 * 1000;
  const toMs = now - toDaysAgo * 24 * 60 * 60 * 1000;
  const filtered = records.filter((r) => {
    const t = r.measuredAt.getTime();
    return t >= fromMs && t <= toMs;
  });
  if (filtered.length === 0) return null;
  const sum = filtered.reduce((s, r) => s + r.value, 0);
  return Math.round((sum / filtered.length) * 100) / 100;
}

/** Compute historical comparison: current 7d avg vs previous 30d avg (days 7-37). */
function computeHistoricalComparison(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
): {
  current7dAvg: number | null;
  previous30dAvg: number | null;
  change: number | null;
} {
  const current7dAvg = avgInWindow(records, now, 7, 0);
  const previous30dAvg = avgInWindow(records, now, 37, 7);
  const change =
    current7dAvg !== null && previous30dAvg !== null
      ? Math.round((current7dAvg - previous30dAvg) * 100) / 100
      : null;
  return { current7dAvg, previous30dAvg, change };
}

/**
 * v1.18.7 — clinical priority order for the signals block. BP / glucose
 * lead, then resting HR / pulse, then weight, then mood.
 * Lower index = higher priority; the briefing surfaces the top ≤3.
 */
const SIGNAL_PRIORITY: SignalOfDay["metric"][] = [
  "bp",
  "glucose",
  "resting_hr",
  "pulse",
  "weight",
  "mood",
];

/** Round helper local to the signals builder. */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Build one signal from a single metric's measurement records. Returns null
 * when there is no fresh reading or fewer than three points in 30 days — a
 * sparse metric cannot carry an honest "today vs your normal" read.
 */
function buildSignal(
  metric: SignalOfDay["metric"],
  label: string,
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  unit?: string,
): SignalOfDay | null {
  if (records.length === 0) return null;
  const newest = records[records.length - 1];
  const latestDaysAgo = Math.round(
    (now - newest.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  // A reading older than two weeks is not a "signal of the day".
  if (latestDaysAgo > 14) return null;

  const win30 = records.filter(
    (rec) => rec.measuredAt.getTime() >= now - 30 * 24 * 60 * 60 * 1000,
  );
  if (win30.length < 3) return null;

  const avg7 = avgInWindow(records, now, 7);
  const avg30 = avgInWindow(records, now, 30);
  const spread30 = stdDev(win30.map((rec) => rec.value));
  const deltaVs7 = avg7 !== null ? r2(newest.value - avg7) : null;
  const deltaVs30 = avg30 !== null ? r2(newest.value - avg30) : null;
  const outsideNormalSwing =
    avg30 !== null && spread30 !== null && spread30 > 0
      ? Math.abs(newest.value - avg30) > spread30
      : false;

  const slope = trendSlope(toDataPoints(records), 30, now);
  const emergingTrend: SignalOfDay["emergingTrend"] = slope
    ? slope.direction === "up"
      ? "rising"
      : slope.direction === "down"
        ? "falling"
        : "flat"
    : null;

  // Recent anomaly: an extreme inside the last 14 days vs the 30d mean ± 2 SD.
  let recentAnomaly: SignalOfDay["recentAnomaly"] = null;
  // Track the RAW extreme magnitude — comparing against the already-r2()
  // rounded stored value can drop a genuinely larger anomaly.
  let bestAbs = 0;
  if (avg30 !== null && spread30 !== null && spread30 > 0) {
    const recent = records.filter(
      (rec) => rec.measuredAt.getTime() >= now - 14 * 24 * 60 * 60 * 1000,
    );
    for (const rec of recent) {
      const sd = (rec.value - avg30) / spread30;
      if (Math.abs(sd) >= 2) {
        const abs = Math.abs(rec.value - avg30);
        if (recentAnomaly === null || abs > bestAbs) {
          bestAbs = abs;
          recentAnomaly = {
            kind: (sd > 0 ? "peak" : "trough") as "peak" | "trough",
            value: r2(rec.value),
            anomalyDaysAgo: Math.round(
              (now - rec.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
            ),
          };
        }
      }
    }
  }

  return {
    metric,
    label,
    ...(unit ? { unit } : {}),
    latest: r2(newest.value),
    latestDaysAgo,
    avg7,
    avg30,
    deltaVs7,
    deltaVs30,
    spread30,
    outsideNormalSwing,
    emergingTrend,
    recentAnomaly,
  };
}

/**
 * v1.18.7 — assemble the present-focused "Signals of the day" block from the
 * in-memory measurement set (no extra DB round-trip). Computes today-vs-7d/30d
 * deltas, an emerging slope, and a recent anomaly per salient metric, then
 * returns the top ≤3 ranked by clinical priority. Salient signals
 * (outside-normal-swing or a recent anomaly) bubble above quiet ones inside
 * each priority tier so the briefing leads with what actually moved.
 */
function computeSignalsOfDay(
  byType: (type: string) => Array<{ value: number; measuredAt: Date }>,
  now: number,
): SignalOfDay[] {
  const candidates: SignalOfDay[] = [];
  const push = (s: SignalOfDay | null) => {
    if (s) candidates.push(s);
  };

  // Systolic carries the BP signal (the headline number clinicians read first).
  push(
    buildSignal(
      "bp",
      "blood pressure (systolic)",
      byType("BLOOD_PRESSURE_SYS"),
      now,
      "mmHg",
    ),
  );
  // Glucose uses the canonical stored value (the model reads the snapshot,
  // not display units); absent data simply produces no signal.
  push(buildSignal("glucose", "blood glucose", byType("BLOOD_GLUCOSE"), now));
  push(
    buildSignal(
      "resting_hr",
      "resting heart rate",
      byType("RESTING_HEART_RATE"),
      now,
      "bpm",
    ),
  );
  push(buildSignal("pulse", "pulse", byType("PULSE"), now, "bpm"));
  push(buildSignal("weight", "weight", byType("WEIGHT"), now, "kg"));
  // Sleep is stored one row per stage per night, so a raw "latest" point
  // would mis-sum; the sleep aggregates carry that signal already. Steps
  // ingest as many intraday `stats:`-prefixed samples, so the newest raw row
  // is a partial-day fragment, not a daily total — excluded like sleep.

  const priorityIndex = (m: SignalOfDay["metric"]) => {
    const idx = SIGNAL_PRIORITY.indexOf(m);
    return idx === -1 ? SIGNAL_PRIORITY.length : idx;
  };
  const salience = (s: SignalOfDay) =>
    (s.outsideNormalSwing ? 2 : 0) + (s.recentAnomaly ? 1 : 0);

  return candidates
    .sort((a, b) => {
      const sal = salience(b) - salience(a);
      if (sal !== 0) return sal;
      return priorityIndex(a.metric) - priorityIndex(b.metric);
    })
    .slice(0, 3);
}

// ─── v1.22 — cross-signal integration blocks (briefing-scoped) ────────────

/**
 * v1.22 — the integration blocks (labs / preventive-care / workouts) carry
 * extra DB reads. They are BRIEFING-scoped: the daily briefing reads a wide
 * window (`BRIEFING_FEATURE_WINDOW_DAYS`) and narrates long trends, while the
 * Coach snapshot path calls `extractFeatures` with a tight ~90-day window and
 * already carries its own labs / illness / workout context. Gating on the read
 * window keeps these extra reads off every Coach turn without a new caller flag:
 * the briefing window (400) clears it, the Coach window (90) does not.
 */
const INTEGRATION_BLOCK_MIN_WINDOW_DAYS = 180;

/** Days a preventive-care item must be due within to surface as "due soon". */
const PREVENTIVE_DUE_HORIZON_DAYS = 21;

/** Cap on items surfaced per preventive-care bucket. */
const PREVENTIVE_MAX_PER_BUCKET = 5;

/** Cap on flagged biomarkers surfaced to the briefing. */
const LABS_MAX_FLAGGED = 8;

/** Only lab readings within this many months are considered "recent". */
const LABS_LOOKBACK_MONTHS = 12;

/** Trailing window (days) for the workout aggregate. */
const WORKOUT_WINDOW_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * v1.25 — newest-first row cap on the bulk measurement read in
 * `extractFeatures`. Mirrors the Coach snapshot's `SNAPSHOT_MEASUREMENT_ROW_CAP`
 * (6000): the prompt / insights aggregates only ever fold this read into a
 * bounded set of summaries, so a year of dense PULSE / glucose rows is wasted
 * I/O on the shared pool for a heavy-data tenant. Full-history extremes come
 * from `readAllTimeExtremes`, not this read, so the cap stays correct.
 */
const FEATURE_MEASUREMENT_ROW_CAP = 6000;

/**
 * Strip control chars + collapse whitespace, then bound the length, before a
 * user-supplied label can reach the briefing prompt. Mirrors the labs /
 * illness snapshot label handling — a self-scoped prompt-injection surface.
 */
function sanitizeLabel(text: string, max = 80): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * v1.22 — recent FLAGGED biomarkers (abnormal or trending) for the briefing.
 * Most-recent reading per biomarker over the lookback window; hidden markers
 * excluded; qualitative rows neutral. Only abnormal (below/above) OR trending
 * markers surface, bounded. Returns `undefined` when nothing is flagged so the
 * block is omitted rather than emitting an empty shape.
 */
async function readLabsBriefingBlock(
  userId: string,
  now: number,
): Promise<AggregatedFeatures["labs"] | undefined> {
  const nowDate = new Date(now);
  const cutoff = new Date(nowDate);
  cutoff.setMonth(cutoff.getMonth() - LABS_LOOKBACK_MONTHS);

  const rows = await prisma.labResult.findMany({
    where: { userId, deletedAt: null, takenAt: { gte: cutoff, lte: nowDate } },
    orderBy: { takenAt: "desc" },
    take: LABS_MAX_FLAGGED * 16,
    select: {
      analyte: true,
      panel: true,
      unit: true,
      value: true,
      valueText: true,
      referenceLow: true,
      referenceHigh: true,
      takenAt: true,
      biomarkerId: true,
      biomarker: {
        select: {
          id: true,
          name: true,
          unit: true,
          lowerBound: true,
          upperBound: true,
          panel: true,
          hidden: true,
        },
      },
    },
  });
  if (rows.length === 0) return undefined;

  // Group rows per biomarker identity (linked id, else lower-cased analyte),
  // newest-first, so we can read the latest reading + the immediately prior one
  // for a trend. Hidden markers are dropped entirely.
  const byMarker = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.biomarker?.hidden) continue;
    const resolved = resolveLabFields(row, row.biomarker);
    const key = row.biomarkerId ?? `analyte:${resolved.analyte.toLowerCase()}`;
    const list = byMarker.get(key) ?? [];
    list.push(row);
    byMarker.set(key, list);
  }

  const flagged: NonNullable<AggregatedFeatures["labs"]>["flagged"] = [];
  for (const list of byMarker.values()) {
    const latest = list[0];
    const resolved = resolveLabFields(latest, latest.biomarker);
    const rangeStatus =
      latest.value === null
        ? ("unknown" as const)
        : classifyReferenceRange(
            latest.value,
            resolved.referenceLow,
            resolved.referenceHigh,
          );

    // Trend = latest numeric reading vs the immediately prior numeric reading.
    let trend: "rising" | "falling" | "flat" | null = null;
    if (latest.value !== null) {
      const prior = list.find((r, i) => i > 0 && r.value !== null);
      if (prior?.value != null) {
        const delta = latest.value - prior.value;
        const eps = Math.max(Math.abs(prior.value) * 0.02, 1e-9);
        trend = delta > eps ? "rising" : delta < -eps ? "falling" : "flat";
      }
    }

    const isAbnormal = rangeStatus === "below" || rangeStatus === "above";
    const isTrending = trend === "rising" || trend === "falling";
    if (!isAbnormal && !isTrending) continue;

    flagged.push({
      analyte: resolved.analyte,
      value: latest.value,
      valueText: latest.valueText ? sanitizeLabel(latest.valueText, 60) : null,
      unit: resolved.unit,
      rangeStatus,
      trend,
      takenAt: latest.takenAt.toISOString(),
      daysAgo: Math.round((now - latest.takenAt.getTime()) / MS_PER_DAY),
    });
  }

  if (flagged.length === 0) return undefined;
  // Abnormal markers lead, then most-recent first.
  flagged.sort((a, b) => {
    const abn = (s: typeof a.rangeStatus) =>
      s === "below" || s === "above" ? 0 : 1;
    const d = abn(a.rangeStatus) - abn(b.rangeStatus);
    return d !== 0 ? d : a.daysAgo - b.daysAgo;
  });
  return {
    flagged: flagged.slice(0, LABS_MAX_FLAGGED),
    flaggedCount: flagged.length,
  };
}

/**
 * v1.22 — preventive-care (Vorsorge) due + overdue read-side. Reads the
 * user's enabled, live reminders and buckets by the server-authoritative
 * `nextDueAt`. Returns `undefined` when nothing is due or overdue.
 */
async function readPreventiveCareBlock(
  userId: string,
  now: number,
): Promise<AggregatedFeatures["preventiveCare"] | undefined> {
  const horizon = new Date(now + PREVENTIVE_DUE_HORIZON_DAYS * MS_PER_DAY);
  const rows = await prisma.measurementReminder.findMany({
    where: {
      userId,
      deletedAt: null,
      enabled: true,
      nextDueAt: { not: null, lte: horizon },
    },
    orderBy: { nextDueAt: "asc" },
    take: (PREVENTIVE_MAX_PER_BUCKET + 1) * 4,
    select: { label: true, nextDueAt: true },
  });
  if (rows.length === 0) return undefined;

  const overdue: NonNullable<AggregatedFeatures["preventiveCare"]>["overdue"] =
    [];
  const due: NonNullable<AggregatedFeatures["preventiveCare"]>["due"] = [];
  for (const r of rows) {
    if (!r.nextDueAt) continue;
    const label = sanitizeLabel(r.label);
    if (!label) continue;
    const diffMs = r.nextDueAt.getTime() - now;
    if (diffMs < 0) {
      overdue.push({ label, daysOverdue: Math.round(-diffMs / MS_PER_DAY) });
    } else {
      due.push({ label, daysUntil: Math.round(diffMs / MS_PER_DAY) });
    }
  }
  if (overdue.length === 0 && due.length === 0) return undefined;
  return {
    overdue: overdue.slice(0, PREVENTIVE_MAX_PER_BUCKET),
    due: due.slice(0, PREVENTIVE_MAX_PER_BUCKET),
  };
}

/**
 * v1.22 — workout aggregate over the trailing window. Provider-agnostic:
 * counts + summed duration + summed distance (km, when any source reported it)
 * over 7 / 30 days, plus the latest workout. Returns `undefined` when no
 * workouts fall in the window.
 */
async function readWorkoutsBlock(
  userId: string,
  now: number,
): Promise<AggregatedFeatures["workouts"] | undefined> {
  const since = new Date(now - WORKOUT_WINDOW_DAYS * MS_PER_DAY);
  const rows = await prisma.workout.findMany({
    where: { userId, startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
    take: 2000,
    select: {
      sportType: true,
      startedAt: true,
      durationSec: true,
      totalDistanceM: true,
    },
  });
  if (rows.length === 0) return undefined;

  const tally = (windowDays: number) => {
    const cutoff = now - windowDays * MS_PER_DAY;
    let count = 0;
    let durationSec = 0;
    let distanceM = 0;
    let anyDistance = false;
    for (const w of rows) {
      if (w.startedAt.getTime() < cutoff) continue;
      count += 1;
      durationSec += w.durationSec;
      if (w.totalDistanceM != null) {
        distanceM += w.totalDistanceM;
        anyDistance = true;
      }
    }
    return {
      count,
      totalDurationMin: Math.round(durationSec / 60),
      totalDistanceKm: anyDistance
        ? Math.round((distanceM / 1000) * 10) / 10
        : null,
    };
  };

  const newest = rows[0];
  const latest = {
    sportType: sanitizeLabel(newest.sportType, 40),
    daysAgo: Math.round((now - newest.startedAt.getTime()) / MS_PER_DAY),
    durationMin: Math.round(newest.durationSec / 60),
    distanceKm:
      newest.totalDistanceM != null
        ? Math.round((newest.totalDistanceM / 1000) * 10) / 10
        : null,
  };

  return { last7: tally(7), last30: tally(30), latest };
}

export async function extractFeatures(
  userId: string,
  includeRaw: boolean,
  options: { sinceDays?: number } = {},
): Promise<AggregatedFeatures | RawFeatures> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      gender: true,
    },
  });

  const now = Date.now();

  // Fetch measurements. Default = ALL (full temporal context for the
  // dashboard / insights generator). Callers that only consume the
  // ≤90-day windows (Coach snapshot per turn) pass `sinceDays: 90` so
  // the per-turn I/O stays bounded — `findMany({ where: { userId } })`
  // is unbounded by user-history size and gets paid once per Coach turn
  // for power users with multi-year Withings imports.
  const sinceDays = options.sinceDays;
  const sinceCutoff =
    typeof sinceDays === "number" && sinceDays > 0
      ? new Date(now - sinceDays * 24 * 60 * 60 * 1000)
      : null;
  // v1.25 — newest-first cap on the bulk feature read, mirroring the Coach
  // snapshot (`SNAPSHOT_MEASUREMENT_ROW_CAP`). Callers pass windows of 365-400
  // days, and PULSE / glucose are 200k-row-class types, so an uncapped read
  // pulled hundreds of thousands of rows per Coach turn and nightly briefing
  // only to fold them into a handful of summaries. Read newest-first, cap, then
  // reverse so every downstream consumer (`byType`, `summarize`, BP pairing,
  // sleep reconstruction, oldest/newest span) still sees ascending order. The
  // cap is safe even unbounded: the genuine all-time extremes are sourced
  // separately via `readAllTimeExtremes` on the bounded branch, so capping only
  // sheds the deepest rows of the bulk read and never relabels an extreme.
  const measurements = await prisma.measurement
    .findMany({
      where: sinceCutoff
        ? { userId, measuredAt: { gte: sinceCutoff }, deletedAt: null }
        : { userId, deletedAt: null },
      orderBy: { measuredAt: "desc" },
      take: FEATURE_MEASUREMENT_ROW_CAP,
      // Project only the columns every downstream consumer reads (`byType`,
      // `summarize`, BP pairing, and `reconstructSleepNights`'s `SleepStageRow`).
      // The PULSE / glucose windows are 200k-row-class; pulling every column
      // (notes, externalId, …) is pure wasted I/O on the shared Prisma pool.
      select: {
        type: true,
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        deviceType: true,
      },
    })
    // Restore ascending order so order-sensitive consumers (oldest/newest span,
    // BP pairing, sleep reconstruction) see the same shape as before the cap.
    .then((rows) => rows.reverse());

  // v1.18.11 P1 — when the bulk read is bounded to a recent window, the
  // windowed `summarize()` no longer covers the full history, so the `allTime*`
  // fields would silently become "last `sinceDays` days" extremes. Source the
  // genuine full-history min / max / mean from one grouped aggregation (no row
  // materialisation) so the labels stay honest. Unbounded reads (sinceCutoff
  // null) already see the whole history and skip the extra query.
  const allTimeExtremes = sinceCutoff
    ? await readAllTimeExtremes(userId, [
        "WEIGHT",
        "BLOOD_PRESSURE_SYS",
        "BLOOD_PRESSURE_DIA",
        "PULSE",
      ])
    : null;

  const byType = (type: string) => measurements.filter((m) => m.type === type);

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);

  // Compute overall data span
  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const overallSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;

  // Compute age
  let ageYears: number | null = null;
  if (user?.dateOfBirth) {
    const dob = user.dateOfBirth;
    const today = new Date();
    ageYears = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      ageYears--;
    }
  }

  const features: AggregatedFeatures = {
    context: {
      heightCm: user?.heightCm ?? null,
      hasBpTargets: !!bpTargets,
      totalMeasurements: measurements.length,
      dataSpanDays: overallSpanDays,
      oldestMeasurementDaysAgo: oldestMeasurement
        ? Math.round(
            (now - oldestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
          )
        : null,
      newestMeasurementDaysAgo: newestMeasurement
        ? Math.round(
            (now - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
          )
        : null,
      ageYears,
      gender: user?.gender ?? null,
    },
  };

  // Weight
  const weightData = byType("WEIGHT");
  if (weightData.length > 0) {
    const summary = summarize(toDataPoints(weightData));
    const bmi =
      user?.heightCm && summary.latest
        ? parseFloat((summary.latest / (user.heightCm / 100) ** 2).toFixed(1))
        : null;

    features.weight = {
      latest: summary.latest!,
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(weightData, now, 90),
      // v1.18.11 P1 — full-history extremes from the grouped aggregation when
      // the bulk read is windowed; the in-window summary otherwise.
      allTimeAvg: allTimeExtremes
        ? roundMean(allTimeExtremes.get("WEIGHT")?.mean ?? null)
        : summary.count > 0
          ? summary.mean
          : null,
      allTimeMin: allTimeExtremes
        ? (allTimeExtremes.get("WEIGHT")?.min ?? null)
        : summary.count > 0
          ? summary.min
          : null,
      allTimeMax: allTimeExtremes
        ? (allTimeExtremes.get("WEIGHT")?.max ?? null)
        : summary.count > 0
          ? summary.max
          : null,
      slope30: summary.slope30?.slope ?? null,
      outlierCount: summary.anomalyCount,
      bmi,
      coverage: computeCoverage(weightData, now),
    };
  }

  // Blood Pressure
  const sysData = byType("BLOOD_PRESSURE_SYS");
  const diaData = byType("BLOOD_PRESSURE_DIA");
  if (sysData.length > 0 || diaData.length > 0) {
    const sysSummary =
      sysData.length > 0 ? summarize(toDataPoints(sysData)) : null;
    const diaSummary =
      diaData.length > 0 ? summarize(toDataPoints(diaData)) : null;

    let pctInTarget: number | null = null;
    if (bpTargets) {
      const sysByTime = new Map(
        sysData.map((m) => [m.measuredAt.getTime(), m.value]),
      );
      let inTargetCount = 0;
      let pairedCount = 0;
      for (const dia of diaData) {
        const sysVal = sysByTime.get(dia.measuredAt.getTime());
        if (sysVal === undefined) continue;
        pairedCount++;
        // v1.4.16 A2 — one-sided ceiling semantics with hypotension
        // floor. See lib/analytics/bp-in-target.ts.
        if (isBpReadingInTarget(sysVal, dia.value, bpTargets)) {
          inTargetCount++;
        }
      }
      pctInTarget =
        pairedCount > 0
          ? Math.round((inTargetCount / pairedCount) * 100)
          : null;
    }

    features.bloodPressure = {
      avgSys30: sysSummary?.avg30 ?? null,
      avgDia30: diaSummary?.avg30 ?? null,
      avgSys90: sysData.length > 0 ? avgInWindow(sysData, now, 90) : null,
      avgDia90: diaData.length > 0 ? avgInWindow(diaData, now, 90) : null,
      // v1.18.11 P1 — full-history extremes when the bulk read is windowed.
      allTimeAvgSys: allTimeExtremes
        ? roundMean(allTimeExtremes.get("BLOOD_PRESSURE_SYS")?.mean ?? null)
        : sysSummary?.count
          ? sysSummary.mean
          : null,
      allTimeAvgDia: allTimeExtremes
        ? roundMean(allTimeExtremes.get("BLOOD_PRESSURE_DIA")?.mean ?? null)
        : diaSummary?.count
          ? diaSummary.mean
          : null,
      allTimeMinSys: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_SYS")?.min ?? null)
        : sysSummary?.count
          ? sysSummary.min
          : null,
      allTimeMaxSys: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_SYS")?.max ?? null)
        : sysSummary?.count
          ? sysSummary.max
          : null,
      allTimeMinDia: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_DIA")?.min ?? null)
        : diaSummary?.count
          ? diaSummary.min
          : null,
      allTimeMaxDia: allTimeExtremes
        ? (allTimeExtremes.get("BLOOD_PRESSURE_DIA")?.max ?? null)
        : diaSummary?.count
          ? diaSummary.max
          : null,
      slopeSys30: sysSummary?.slope30?.slope ?? null,
      slopeDia30: diaSummary?.slope30?.slope ?? null,
      sdSys30: (() => {
        const fromMs = now - 30 * 24 * 60 * 60 * 1000;
        const vals = sysData
          .filter((m) => m.measuredAt.getTime() >= fromMs)
          .map((m) => m.value);
        return stdDev(vals);
      })(),
      sdDia30: (() => {
        const fromMs = now - 30 * 24 * 60 * 60 * 1000;
        const vals = diaData
          .filter((m) => m.measuredAt.getTime() >= fromMs)
          .map((m) => m.value);
        return stdDev(vals);
      })(),
      pulsePressure30: (() => {
        const avgSys = sysSummary?.avg30 ?? null;
        const avgDia = diaSummary?.avg30 ?? null;
        if (avgSys === null || avgDia === null) return null;
        return Math.round((avgSys - avgDia) * 10) / 10;
      })(),
      pctInTarget,
      coverage: computeCoverage(
        [...sysData, ...diaData].sort(
          (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
        ),
        now,
      ),
    };
  }

  // Pulse
  const pulseData = byType("PULSE");
  if (pulseData.length > 0) {
    const summary = summarize(toDataPoints(pulseData));
    features.pulse = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(pulseData, now, 90),
      // v1.18.11 P1 — full-history extremes when the bulk read is windowed.
      allTimeAvg: allTimeExtremes
        ? roundMean(allTimeExtremes.get("PULSE")?.mean ?? null)
        : summary.count > 0
          ? summary.mean
          : null,
      allTimeMin: allTimeExtremes
        ? (allTimeExtremes.get("PULSE")?.min ?? null)
        : summary.count > 0
          ? summary.min
          : null,
      allTimeMax: allTimeExtremes
        ? (allTimeExtremes.get("PULSE")?.max ?? null)
        : summary.count > 0
          ? summary.max
          : null,
      slope30: summary.slope30?.slope ?? null,
      anomalyCount: summary.anomalyCount,
      coverage: computeCoverage(pulseData, now),
    };
  }

  // Body Fat
  const fatData = byType("BODY_FAT");
  if (fatData.length > 0) {
    const summary = summarize(toDataPoints(fatData));
    features.bodyFat = {
      latest: summary.latest,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      coverage: computeCoverage(fatData, now),
    };
  }

  // Sleep Duration
  //
  // SLEEP_DURATION is stored ONE ROW PER STAGE per night, so summarising the
  // raw stage rows would average individual stages (and double-count a bare
  // ASLEEP aggregate against its granular CORE/DEEP/REM twin). Route the
  // feature block through the per-night dedup reconstruction — the same helper
  // the dashboard / series / status path use — so `avg7` / `avg30` / `latest`
  // are per-night TIME-ASLEEP totals in minutes, never stage averages.
  const sleepData = byType("SLEEP_DURATION");
  if (sleepData.length > 0) {
    const [sleepTz, sleepPriority] = await Promise.all([
      resolveUserTimezone(userId),
      loadUserSourcePriority(userId),
    ]);
    const sleepNights = reconstructSleepNights(
      sleepData as unknown as SleepStageRow[],
      sleepTz,
      sleepPriority,
    ).filter((n) => n.asleepMinutes > 0);
    const summary = summarize(
      sleepNights.map((n) => ({ date: n.measuredAt, value: n.asleepMinutes })),
    );
    features.sleep = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      latest: summary.latest,
      coverage: computeCoverage(
        sleepNights.map((n) => ({ measuredAt: n.measuredAt })),
        now,
      ),
    };
  }

  // Activity Steps
  const activityData = byType("ACTIVITY_STEPS");
  if (activityData.length > 0) {
    const summary = summarize(toDataPoints(activityData));
    features.activity = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      latest: summary.latest,
      coverage: computeCoverage(activityData, now),
    };
  }

  // Mood
  //
  // v1.4.40 — swap the unbounded `prisma.moodEntry.findMany` for the
  // persistent mood-rollup DAY tier (audit Critical Finding #2). The
  // feature block downstream consumes:
  //   - `avg7` / `avg30` over recent rollup means
  //   - `trend30` from first-half vs second-half of last 30 days
  //   - `latest` = newest individual entry score (one bounded row)
  //   - `totalEntries` = sum of rollup `count` across all DAY rows
  //   - `oldest` / `newest` = first and last rollup `bucketStart`
  //   - `moodPoints` for cross-metric correlations (one per-day mean
  //     DataPoint — same resolution as the legacy raw-score series for
  //     single-entry-per-day power users, slightly different on
  //     multi-entry days, which is the rollup-tier semantic the
  //     v1.4.39 `/api/mood/analytics` already shipped)
  //
  // Coverage-fallback: when raw entries exist but the rollup tier is
  // still empty (legacy account before boot-time backfill caught up),
  // we fall back to a bounded 1-year raw walk and fire the warm-up so
  // the next request lands on the rollup tier. Same posture as
  // `/api/mood/analytics`.
  void ensureUserMoodRollupsFresh(userId);
  // Five-year window mirrors the mood-rollup writer default; covers
  // every realistic user history span without an unbounded scan.
  const moodSince = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const moodRollupDayRows = await readMoodDayRollups(userId, moodSince);

  type MoodDayPoint = {
    measuredAt: Date;
    value: number;
    count: number;
  };
  let moodDailyPoints: MoodDayPoint[] = [];
  let moodLatestScore: number | null = null;
  let moodTotalEntries = 0;

  if (moodRollupDayRows.length > 0) {
    moodDailyPoints = moodRollupDayRows.map((r) => ({
      measuredAt: r.bucketStart,
      value: r.mean,
      count: r.count,
    }));
    moodTotalEntries = moodRollupDayRows.reduce((s, r) => s + r.count, 0);
    // Latest score = newest individual entry (one bounded row).
    const latestEntry = await prisma.moodEntry.findFirst({
      // v1.7.0 sync — exclude tombstoned rows.
      where: { userId, deletedAt: null },
      orderBy: { moodLoggedAt: "desc" },
      select: { score: true },
    });
    moodLatestScore = latestEntry?.score ?? null;
  } else {
    // Coverage-fallback. Bounded 1-year walk (instead of the legacy
    // unbounded `findMany`) so even a cache miss is capped.
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const moodEntriesRaw = await prisma.moodEntry.findMany({
      // v1.7.0 sync — exclude tombstoned rows.
      where: { userId, deletedAt: null, moodLoggedAt: { gte: oneYearAgo } },
      orderBy: { moodLoggedAt: "asc" },
      select: { score: true, moodLoggedAt: true, date: true },
    });
    if (moodEntriesRaw.length > 0) {
      // Bucket per `date` (TZ-anchored YYYY-MM-DD label, same key the
      // rollup tier would emit for Berlin-anchored single-entry days)
      // so the fallback shape matches the rollup-tier shape.
      const byDay = new Map<string, { sum: number; count: number; ts: Date }>();
      for (const e of moodEntriesRaw) {
        const k = e.date;
        const cur = byDay.get(k) ?? { sum: 0, count: 0, ts: e.moodLoggedAt };
        cur.sum += e.score;
        cur.count += 1;
        // Pin the bucket's measuredAt to the latest entry's timestamp
        // — close enough for the trailing-window filters below.
        if (e.moodLoggedAt > cur.ts) cur.ts = e.moodLoggedAt;
        byDay.set(k, cur);
      }
      moodDailyPoints = Array.from(byDay.values())
        .map((b) => ({
          measuredAt: b.ts,
          value: b.sum / b.count,
          count: b.count,
        }))
        .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
      moodTotalEntries = moodEntriesRaw.length;
      moodLatestScore = moodEntriesRaw[moodEntriesRaw.length - 1].score;
    }
  }

  if (moodDailyPoints.length > 0) {
    const moodNow = Date.now();
    const last7 = moodDailyPoints.filter(
      (e) => moodNow - e.measuredAt.getTime() < 7 * 24 * 60 * 60 * 1000,
    );
    const last30 = moodDailyPoints.filter(
      (e) => moodNow - e.measuredAt.getTime() < 30 * 24 * 60 * 60 * 1000,
    );

    const avg = (points: MoodDayPoint[]) =>
      points.length > 0
        ? Math.round(
            (points.reduce((s, e) => s + e.value, 0) / points.length) * 100,
          ) / 100
        : null;

    // Compute 30-day trend: compare first half vs second half of last 30 days
    let trend30: "improving" | "declining" | "stable" | null = null;
    if (last30.length >= 4) {
      const firstHalf = last30.filter(
        (e) => moodNow - e.measuredAt.getTime() >= 15 * 24 * 60 * 60 * 1000,
      );
      const secondHalf = last30.filter(
        (e) => moodNow - e.measuredAt.getTime() < 15 * 24 * 60 * 60 * 1000,
      );
      if (firstHalf.length >= 2 && secondHalf.length >= 2) {
        const avgFirst = avg(firstHalf)!;
        const avgSecond = avg(secondHalf)!;
        const diff = avgSecond - avgFirst;
        if (diff > 0.3) trend30 = "improving";
        else if (diff < -0.3) trend30 = "declining";
        else trend30 = "stable";
      }
    }

    const oldest = moodDailyPoints[0].measuredAt;
    const newest = moodDailyPoints[moodDailyPoints.length - 1].measuredAt;
    const spanDays = Math.round(
      (newest.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000),
    );
    const avgDaysBetween =
      moodTotalEntries > 1
        ? Math.round((spanDays / (moodTotalEntries - 1)) * 10) / 10
        : null;

    features.mood = {
      scale: "1=LAUSIG, 2=SCHLECHT, 3=OKAY, 4=GUT, 5=SUPER_GUT",
      avg7: avg(last7),
      avg30: avg(last30),
      latest: moodLatestScore,
      trend30,
      totalEntries: moodTotalEntries,
      coverage: {
        count: moodTotalEntries,
        spanDays,
        avgDaysBetween,
        oldestDaysAgo: Math.round(
          (moodNow - oldest.getTime()) / (24 * 60 * 60 * 1000),
        ),
        newestDaysAgo: Math.round(
          (moodNow - newest.getTime()) / (24 * 60 * 60 * 1000),
        ),
      },
    };
  }

  // Cross-metric correlations
  const weightPoints = toDataPoints(weightData);
  const sysPoints = toDataPoints(sysData);
  const diaPoints = toDataPoints(diaData);
  const pulsePoints = toDataPoints(pulseData);
  const moodPoints: DataPoint[] = moodDailyPoints.map((e) => ({
    date: e.measuredAt,
    value: e.value,
  }));

  const computeCorr = (a: DataPoint[], b: DataPoint[]) =>
    pearsonCorrelation(pairByTimestamp(a, b));

  const sleepPoints = toDataPoints(sleepData);

  features.correlations = {
    weightVsSystolic: computeCorr(weightPoints, sysPoints),
    weightVsDiastolic: computeCorr(weightPoints, diaPoints),
    pulseVsSystolic: computeCorr(pulsePoints, sysPoints),
    moodVsPulse: computeCorr(moodPoints, pulsePoints),
    moodVsSystolic: computeCorr(moodPoints, sysPoints),
    moodVsWeight: computeCorr(moodPoints, weightPoints),
    sleepVsPulse:
      sleepData.length > 0 ? computeCorr(sleepPoints, pulsePoints) : null,
    sleepVsSystolic:
      sleepData.length > 0 ? computeCorr(sleepPoints, sysPoints) : null,
  };

  // Rate-Pressure Product (RPP) — myocardial oxygen demand indicator
  if (features.pulse && features.bloodPressure) {
    const rpp7 =
      features.pulse.avg7 !== null && features.bloodPressure.avgSys30 !== null
        ? Math.round(
            features.pulse.avg7 *
              (avgInWindow(sysData, now, 7) ?? features.bloodPressure.avgSys30),
          )
        : null;
    const rpp30 =
      features.pulse.avg30 !== null && features.bloodPressure.avgSys30 !== null
        ? Math.round(features.pulse.avg30 * features.bloodPressure.avgSys30)
        : null;
    const rppRef = rpp30 ?? rpp7;
    features.ratePressureProduct = {
      rpp7,
      rpp30,
      risk: rppRef !== null ? (rppRef > 12000 ? "elevated" : "normal") : null,
    };
  }

  // Body Composition Divergence
  if (features.weight && features.bodyFat) {
    const weightStable =
      features.weight.slope30 !== null &&
      Math.abs(features.weight.slope30) < 0.01;
    const bodyFatRising =
      features.bodyFat.slope30 !== null && features.bodyFat.slope30 > 0;
    features.bodyCompositionDivergence = {
      weightStable,
      bodyFatRising,
      flag: weightStable && bodyFatRising,
    };
  }

  // Mood-Adherence Risk Flag
  if (
    features.mood &&
    features.medications &&
    features.medications.length > 0
  ) {
    features.moodAdherenceRisk =
      features.mood.avg7 !== null &&
      features.mood.avg7 <= 2.5 &&
      features.mood.trend30 === "declining";
  }

  // Seasonal BP Variation (only if > 180 days of data)
  if (features.context.dataSpanDays > 180 && sysData.length > 0) {
    const winterMonths = [11, 0, 1]; // Dec, Jan, Feb (0-indexed)
    const summerMonths = [5, 6, 7]; // Jun, Jul, Aug
    const winterVals = sysData
      .filter((m) => winterMonths.includes(m.measuredAt.getMonth()))
      .map((m) => m.value);
    const summerVals = sysData
      .filter((m) => summerMonths.includes(m.measuredAt.getMonth()))
      .map((m) => m.value);
    const winterAvg =
      winterVals.length > 0
        ? Math.round(
            (winterVals.reduce((s, v) => s + v, 0) / winterVals.length) * 10,
          ) / 10
        : null;
    const summerAvg =
      summerVals.length > 0
        ? Math.round(
            (summerVals.reduce((s, v) => s + v, 0) / summerVals.length) * 10,
          ) / 10
        : null;
    const delta =
      winterAvg !== null && summerAvg !== null
        ? Math.round((winterAvg - summerAvg) * 10) / 10
        : null;
    features.seasonalVariation = {
      winterAvgSys: winterAvg,
      summerAvgSys: summerAvg,
      delta,
      significance:
        delta !== null ? (Math.abs(delta) > 5 ? "elevated" : "normal") : null,
    };
  }

  // Historical comparison: current 7d avg vs previous 30d avg (days 7-37)
  features.historicalComparison = {};
  if (weightData.length > 0) {
    features.historicalComparison.weight = computeHistoricalComparison(
      weightData,
      now,
    );
  }
  if (sysData.length > 0) {
    features.historicalComparison.systolic = computeHistoricalComparison(
      sysData,
      now,
    );
  }
  if (diaData.length > 0) {
    features.historicalComparison.diastolic = computeHistoricalComparison(
      diaData,
      now,
    );
  }
  if (pulseData.length > 0) {
    features.historicalComparison.pulse = computeHistoricalComparison(
      pulseData,
      now,
    );
  }

  // Medications
  const medications = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never surface a compliance
    // rate (no expected doses), so the insight features exclude them.
    where: { userId, active: true, asNeeded: false },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });

  if (medications.length > 0) {
    const categoryMap = await getMedicationCategories(
      medications.map((med) => med.id),
    );

    // Single batched fetch + in-memory grouping replaces the per-medication
    // findMany loop. Same shape as the v1.3.0 fix to /api/insights/comprehensive
    // (the previous N+1 the v3 audit closed). 90 days is the longest window
    // calculateCompliance uses below, so we don't need the full intake history.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const allEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        // v1.7.0 sync — exclude tombstoned rows.
        deletedAt: null,
        medicationId: { in: medications.map((med) => med.id) },
        scheduledFor: { gte: ninetyDaysAgo },
      },
      orderBy: { scheduledFor: "desc" },
      select: {
        medicationId: true,
        takenAt: true,
        skipped: true,
        scheduledFor: true,
      },
    });

    const eventsByMed = new Map<
      string,
      { takenAt: Date | null; skipped: boolean; scheduledFor: Date }[]
    >();
    for (const e of allEvents) {
      const list = eventsByMed.get(e.medicationId) ?? [];
      list.push({
        takenAt: e.takenAt,
        skipped: e.skipped,
        scheduledFor: e.scheduledFor,
      });
      eventsByMed.set(e.medicationId, list);
    }

    // v1.7.0 SB-SCHED-2 — resolve the user timezone once so every
    // per-med compliance call can route its denominator through the
    // canonical engine (RRULE / rolling / one-shot / PRN / cyclic).
    const userTz = await resolveUserTimezone(userId);

    features.medications = medications.map((med) => {
      const mapped = eventsByMed.get(med.id) ?? [];
      const medicationContext = buildComplianceMedicationContext(
        med,
        lastNonSkippedTakenAt(mapped),
        userTz,
      );
      const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
        medicationContext,
      });
      const c30 = calculateCompliance(
        mapped,
        med.schedules,
        30,
        med.createdAt,
        {
          medicationContext,
        },
      );
      const c90 = calculateCompliance(
        mapped,
        med.schedules,
        90,
        med.createdAt,
        {
          medicationContext,
        },
      );

      return {
        name: med.name,
        dose: med.dose,
        category: categoryMap[med.id] ?? "OTHER",
        compliance7: c7.rate,
        compliance30: c30.rate,
        compliance90: c90.rate,
        streak: c30.streak,
        missedLast7: c7.missed,
      };
    });
  }

  // v1.18.7 — present-focused "Signals of the day". Computed from the
  // in-memory measurement set (no extra DB round-trip). Lands inside the
  // compacted features payload, so it feeds both the briefing prompt AND the
  // content-hash gate — a fresh daily signal forces the briefing to refresh.
  const signalsOfDay = computeSignalsOfDay(byType, now);
  if (signalsOfDay.length > 0) {
    features.signalsOfDay = signalsOfDay;
  }

  // v1.22 — glucose aggregate block. Computed from the already-fetched
  // measurement set (no extra DB read), so it is always cheap to emit. Glucose
  // previously reached the briefing only as one `signalOfDay` row.
  const glucoseData = byType("BLOOD_GLUCOSE");
  if (glucoseData.length > 0) {
    const summary = summarize(toDataPoints(glucoseData));
    const newest = glucoseData[glucoseData.length - 1];
    features.glucose = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(glucoseData, now, 90),
      latest: summary.latest,
      latestDaysAgo: Math.round(
        (now - newest.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
      ),
      slope30: summary.slope30?.slope ?? null,
      coverage: computeCoverage(glucoseData, now),
    };
  }

  // v1.22 — cross-signal integration blocks (labs / preventive-care /
  // workouts). Briefing-scoped: only the wide briefing window pays the extra
  // reads; the tight Coach-snapshot window (which carries its own labs / illness
  // / workout context) skips them. Each block is omitted when its domain is
  // empty (no fabricated zeros). Fetched in parallel — independent reads.
  const includeIntegrations =
    sinceCutoff === null ||
    (typeof sinceDays === "number" &&
      sinceDays >= INTEGRATION_BLOCK_MIN_WINDOW_DAYS);
  if (includeIntegrations) {
    const [labs, preventiveCare, workouts] = await Promise.all([
      readLabsBriefingBlock(userId, now),
      readPreventiveCareBlock(userId, now),
      readWorkoutsBlock(userId, now),
    ]);
    if (labs) features.labs = labs;
    if (preventiveCare) features.preventiveCare = preventiveCare;
    if (workouts) features.workouts = workouts;
  }

  // v1.4.36 W3 T1 — "raw" mode no longer dumps every measurement row
  // into the prompt. Instead we attach DAY / WEEK / MONTH bucket means
  // from `measurement_rollups` so the model gets the same temporal
  // shape (granular near-term, coarser deep history) at O(buckets)
  // instead of O(rows). The v1.4.35 shape blew past Codex's 10 MB
  // string limit on power users (~25.9 MB observed); the bucketed
  // shape lands at ~50–500 KB per account.
  if (includeRaw) {
    const bucketedMeasurements = await readBucketedSeries(userId, now);
    const rawFeatures: RawFeatures = {
      ...features,
      bucketedMeasurements,
    };
    enforceSizeGuard(rawFeatures);
    return rawFeatures;
  }

  enforceSizeGuard(features);
  return features;
}

/**
 * Read every BUCKETED_TYPES × BUCKET_WINDOWS combination from the
 * persistent rollup table and project to the wire shape. Empty
 * (type, granularity) combinations are dropped so the payload never
 * carries a labelled-but-empty series.
 */
async function readBucketedSeries(
  userId: string,
  now: number,
): Promise<BucketedSeries[]> {
  const series: BucketedSeries[] = [];
  for (const type of BUCKETED_TYPES) {
    for (const window of BUCKET_WINDOWS) {
      const from = new Date(now - window.toDays * 24 * 60 * 60 * 1000);
      const to = new Date(now - window.fromDays * 24 * 60 * 60 * 1000);
      const rows = await readRollupBuckets(
        userId,
        type,
        window.granularity,
        from,
        to,
      );
      if (rows.length === 0) continue;
      series.push({
        type,
        granularity: window.granularity,
        buckets: rows.map((r) => ({
          bucketStart: r.bucketStart.toISOString(),
          mean: Math.round(r.mean * 100) / 100,
          count: r.count,
        })),
      });
    }
  }
  return series;
}

/**
 * Hard ceiling on the serialised payload. Throws
 * `FeaturesPayloadTooLargeError` (tagged with `code` so the route
 * handler can pattern-match) when the JSON dump crosses
 * `FEATURES_MAX_BYTES`. The route handler downgrades to the non-raw
 * shape and annotates so the regression is observable; the model
 * call still succeeds.
 */
function enforceSizeGuard(payload: AggregatedFeatures | RawFeatures): void {
  const sizeBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (sizeBytes > FEATURES_MAX_BYTES) {
    throw new FeaturesPayloadTooLargeError(sizeBytes, FEATURES_MAX_BYTES);
  }
}
