/**
 * Phase 4 — deep-value MCP read tools (engine glue).
 *
 * Four "bring data into relation" reads, each a THIN re-export of an existing
 * server-authoritative engine — no new statistics, no new business logic
 * (REQ-WONT-2 / catalogue §5):
 *
 *   1. get_correlation     — one named driver pair out of the FDR-controlled,
 *                            lag-aware discovery (`readCoachCorrelations`, the
 *                            same engine the Coach `get_correlations` tool and
 *                            the `/api/insights/correlations` route run).
 *   2. compare_metric      — two trailing-window or two-metric rollup snapshots
 *                            side by side (`readBestGranularityRollups` +
 *                            `aggregateWmyBuckets`) with structured deltas.
 *   3. get_metric_baseline — the metric's personal usual range (median ± k·MAD)
 *                            + today's placement, via `buildCoachReadStrip`
 *                            (the same engine the metric-page "Coach read" strip
 *                            renders).
 *   4. detect_changepoints — level shifts in a metric over the rollup tier, via
 *                            a minimal in-repo CUSUM binary-segmentation over the
 *                            rollup bucket means (no heavy dependency, high
 *                            firing bar).
 *
 * Grounding contract (REQ-SEC-2/3/4, ADR-004): every read returns structured
 * values + units + reference bands + provenance and uses `{ present: false }`
 * for absence / insufficiency — never a silent zero, never a prose verdict or
 * diagnosis. Associations are described, never asserted as causal. `userId` is
 * the session-narrowed id passed by the caller, never a tool argument
 * (REQ-SEC-5). All reads are read-only.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import {
  readBestGranularityRollups,
  aggregateWmyBuckets,
  type RollupBucketRow,
} from "@/lib/rollups/measurement-read-wmy";
import {
  getMetricStatusMeta,
  METRIC_STATUS_IDS,
} from "@/lib/insights/metric-status-registry";
import { classifyReferenceRange } from "@/lib/labs/reference-range";
import { resolveLabFields } from "@/lib/labs/serialise";
import { sanitizeValueText } from "@/lib/ai/coach/labs-snapshot";
import { encodeOffsetCursor } from "@/lib/mcp/pagination";
import type { CoachScopeWindow } from "@/lib/ai/coach/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * An explicit, arbitrary ISO date range the rich reads can take in place of one
 * of the five fixed trailing windows. Bounds are inclusive. The range is served
 * over the SAME rollup tier the trailing windows use: the reader fetches the
 * trailing buckets reaching back to `from` (the largest granularity that still
 * resolves that span) and the rich read filters them to `[from, to]` — no new
 * persisted analytics, no recompute. A coarse granularity (WEEK / MONTH /
 * YEAR) is selected automatically for a range that reaches far into the past,
 * and the resolved granularity is reported on the result.
 */
export interface DateRange {
  /** Inclusive lower bound (ISO-8601 instant). */
  from: string;
  /** Inclusive upper bound (ISO-8601 instant). */
  to: string;
}

/**
 * Validate + normalise an explicit `{from,to}` range to millisecond bounds.
 * Returns `null` for a missing, unparseable, or inverted range so the caller
 * falls back to the trailing-window path rather than reading a nonsense span.
 */
function resolveRangeMs(
  range: DateRange | undefined,
): { fromMs: number; toMs: number } | null {
  if (!range) return null;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  if (toMs <= fromMs) return null;
  return { fromMs, toMs };
}

/** Trailing-day count for each window the rich reads accept. */
const WINDOW_DAYS: Record<CoachScopeWindow, number> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
  // The rollup tier caps "all time" timelines at one year elsewhere; keep the
  // rich reads bounded to the same ceiling so the token budget stays sane.
  allTime: 365,
};

function windowToDays(window: CoachScopeWindow | undefined): number {
  return WINDOW_DAYS[window ?? "last30days"];
}

// ── Metric resolution ────────────────────────────────────────────────
//
// A scalar metric the rich reads can place on a single rollup series, carrying
// its canonical unit + population reference band (when a broadly-accepted one
// exists). Most entries are derived straight from the single-source
// `metric-status-registry`; a small explicit supplement covers the headline
// specialised metrics (weight / pulse / BMI) the registry intentionally omits.

export interface RichMetric {
  /** The DB `MeasurementType` the rollup tier + baseline engine read against. */
  measurementType: MeasurementType;
  /** Human label for the resolved metric (provenance / narration). */
  label: string;
  /** Canonical storage unit. */
  unit: string;
  /** Population reference band, or `null` when no universal band exists. */
  band: { low: number; high: number } | null;
}

/** Headline specialised metrics the status registry does not carry. */
const SUPPLEMENT: Record<string, RichMetric> = {
  weight: {
    measurementType: "WEIGHT",
    label: "Weight",
    unit: "kg",
    // No universal healthy band — body-size dependent; defer to own baseline.
    band: null,
  },
  pulse: {
    measurementType: "PULSE",
    label: "Pulse",
    unit: "bpm",
    band: { low: 60, high: 100 },
  },
  bmi: {
    measurementType: "BODY_MASS_INDEX",
    label: "Body-mass index",
    unit: "kg/m²",
    band: { low: 18.5, high: 25 },
  },
};

/** Friendly aliases (Coach source slugs + natural phrasings) → registry id. */
const ALIASES: Record<string, string> = {
  resting_hr: "RESTING_HEART_RATE",
  resting_heart_rate: "RESTING_HEART_RATE",
  hrv: "HEART_RATE_VARIABILITY",
  spo2: "OXYGEN_SATURATION",
  blood_oxygen: "OXYGEN_SATURATION",
  vo2_max: "VO2_MAX",
  vo2max: "VO2_MAX",
  steps: "STEPS",
  glucose: "BLOOD_GLUCOSE",
  blood_glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  sleep_duration: "SLEEP_DURATION",
  distance: "WALKING_RUNNING_DISTANCE",
  active_energy: "ACTIVE_ENERGY",
  body_temp: "BODY_TEMPERATURE",
  body_temperature: "BODY_TEMPERATURE",
  daylight: "TIME_IN_DAYLIGHT",
  respiratory_rate: "RESPIRATORY_RATE",
  walking_hr: "WALKING_HEART_RATE_AVERAGE",
};

function fromRegistry(id: string): RichMetric | null {
  const meta = getMetricStatusMeta(id);
  if (!meta) return null;
  return {
    measurementType: meta.measurementType,
    label: meta.displayName,
    unit: meta.unit,
    band: meta.normalRange
      ? { low: meta.normalRange.low, high: meta.normalRange.high }
      : null,
  };
}

/**
 * Resolve a free-text metric name to a single scalar series. Forgiving for an
 * NL assistant (alias, exact id, display-name match) but closed — an
 * unresolved name returns `null` so the tool reports `{ present: false }`
 * rather than inventing a series. Multi-series metrics (blood pressure) are not
 * resolvable here by design; the prompt + `get_metric_series` cover BP.
 */
export function resolveRichMetric(input: string): RichMetric | null {
  const raw = input.trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");

  // 1. explicit supplement (weight / pulse / bmi).
  if (SUPPLEMENT[key]) return SUPPLEMENT[key];

  // 2. friendly alias → registry id.
  const aliased = ALIASES[key];
  if (aliased) return fromRegistry(aliased);

  // 3. exact registry id (case-insensitive).
  const upper = key.toUpperCase();
  if ((METRIC_STATUS_IDS as readonly string[]).includes(upper)) {
    const direct = fromRegistry(upper);
    if (direct) return direct;
  }

  // 4. display-name match (e.g. "heart-rate variability").
  const needle = raw.toLowerCase();
  for (const id of METRIC_STATUS_IDS) {
    const meta = getMetricStatusMeta(id);
    if (!meta) continue;
    const name = meta.displayName.toLowerCase();
    if (name === needle || name.includes(needle) || needle.includes(name)) {
      return fromRegistry(id);
    }
  }
  return null;
}

// ── 1. get_correlation ───────────────────────────────────────────────

export interface CorrelationResult {
  present: boolean;
  reason?: string;
  /** The matched driver pair (descriptive, never causal). */
  pair?: {
    behaviour: string;
    outcome: string;
    direction: "higher" | "lower";
    lagDays: number;
    n: number;
    r: number;
    note: string;
  };
  /** Honest footer — pairs tested + window the discovery scanned. */
  pairsTested?: number;
  windowDays?: number;
  /** Constant marker so the model never re-frames the link as causal. */
  association?: "descriptive";
}

function norm(label: string): string {
  return label.trim().toLowerCase();
}

/** True when `a`/`b` (either order) match the driver's behaviour/outcome. */
function pairMatches(
  behaviour: string,
  outcome: string,
  a: string,
  b: string,
): boolean {
  const contains = (hay: string, needle: string) =>
    hay.includes(needle) || needle.includes(hay);
  return (
    (contains(behaviour, a) && contains(outcome, b)) ||
    (contains(behaviour, b) && contains(outcome, a))
  );
}

/**
 * Return the FDR-controlled, lag-aware association between two named metrics.
 * Pure re-export: runs the SAME discovery the Coach `get_correlations` tool and
 * the insight route run, then selects the surviving pair (strongest |r|) that
 * matches the requested two metrics — never re-computing a relationship the
 * engine did not surface. Honest `{ present: false }` when no surviving pair
 * matches (sparse data, or the link did not clear the engine's floors).
 */
export async function getCorrelation(
  userId: string,
  args: { metricA: string; metricB: string },
): Promise<CorrelationResult> {
  const a = norm(args.metricA);
  const b = norm(args.metricB);
  const result = await readCoachCorrelations(userId);

  if (!result.present || !result.drivers || result.drivers.length === 0) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_correlation", present: false },
    });
    return {
      present: false,
      reason: result.reason ?? "no_significant_pattern",
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    };
  }

  const matches = result.drivers.filter((d) =>
    pairMatches(norm(d.behaviour), norm(d.outcome), a, b),
  );
  if (matches.length === 0) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_correlation", present: false },
    });
    return {
      present: false,
      reason: "no_significant_pattern_for_pair",
      pairsTested: result.pairsTested,
      windowDays: result.windowDays,
    };
  }

  const best = matches.reduce((acc, cur) =>
    Math.abs(cur.r) > Math.abs(acc.r) ? cur : acc,
  );
  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "get_correlation", present: true },
  });
  return {
    present: true,
    pair: {
      behaviour: best.behaviour,
      outcome: best.outcome,
      direction: best.direction,
      lagDays: best.lagDays,
      n: best.n,
      r: best.r,
      note: best.note,
    },
    pairsTested: result.pairsTested,
    windowDays: result.windowDays,
    association: "descriptive",
  };
}

// ── 2. compare_metric ────────────────────────────────────────────────

interface MetricWindowSnapshot {
  label: string;
  unit: string;
  band: { low: number; high: number } | null;
  windowDays: number;
  granularity: string;
  count: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Lower bound when the side was an explicit `{from,to}` range. */
  from?: string;
  /** Upper bound when the side was an explicit `{from,to}` range. */
  to?: string;
}

export interface CompareMetricResult {
  present: boolean;
  reason?: string;
  mode?: "metric_vs_metric" | "window_vs_window";
  a?: MetricWindowSnapshot;
  b?: MetricWindowSnapshot;
  /** Delta b − a, only when both sides share a unit; null otherwise. */
  delta?: { mean: number; pct: number | null } | null;
}

/** One side's horizon: an explicit range wins over a trailing window. */
interface SideSpec {
  window?: CoachScopeWindow;
  range?: DateRange;
}

async function snapshotMetricWindow(
  userId: string,
  metric: RichMetric,
  windowDays: number,
): Promise<MetricWindowSnapshot | null> {
  const read = await readBestGranularityRollups(
    userId,
    metric.measurementType,
    windowDays,
  );
  if (!read || read.rows.length === 0) return null;
  const agg = aggregateWmyBuckets(read.rows);
  if (agg.count === 0) return null;
  return {
    label: metric.label,
    unit: metric.unit,
    band: metric.band,
    windowDays,
    granularity: read.granularity,
    count: agg.count,
    mean: agg.mean,
    min: agg.min,
    max: agg.max,
  };
}

/**
 * Snapshot a metric over an explicit `{from,to}` range. Reuses the SAME rollup
 * reader the trailing-window path uses: it fetches the trailing buckets reaching
 * back to `from` (so the largest granularity that still resolves that reach is
 * picked) and filters them to `[from, to]`. No new persisted analytics.
 */
async function snapshotMetricRange(
  userId: string,
  metric: RichMetric,
  fromMs: number,
  toMs: number,
): Promise<MetricWindowSnapshot | null> {
  // Reach back far enough to cover `from`; the upper bound is applied below.
  const reachDays = Math.ceil((Date.now() - fromMs) / DAY_MS);
  if (!Number.isFinite(reachDays) || reachDays <= 0) return null;
  const read = await readBestGranularityRollups(
    userId,
    metric.measurementType,
    reachDays,
  );
  if (!read) return null;
  const rows = read.rows.filter((r) => {
    const t = r.bucketStart.getTime();
    return t >= fromMs && t <= toMs;
  });
  if (rows.length === 0) return null;
  const agg = aggregateWmyBuckets(rows);
  if (agg.count === 0) return null;
  return {
    label: metric.label,
    unit: metric.unit,
    band: metric.band,
    windowDays: Math.max(1, Math.round((toMs - fromMs) / DAY_MS)),
    granularity: read.granularity,
    count: agg.count,
    mean: agg.mean,
    min: agg.min,
    max: agg.max,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

/** Snapshot one comparison side — an explicit range wins over a window. */
function snapshotSide(
  userId: string,
  metric: RichMetric,
  spec: SideSpec,
): Promise<MetricWindowSnapshot | null> {
  const range = resolveRangeMs(spec.range);
  if (range) {
    return snapshotMetricRange(userId, metric, range.fromMs, range.toMs);
  }
  return snapshotMetricWindow(userId, metric, windowToDays(spec.window));
}

/**
 * Compare a metric against another metric (same horizon) OR a single metric
 * across two horizons. Each horizon is either one of the five fixed trailing
 * windows OR an explicit `{from,to}` range (e.g. before vs after a date). Pure
 * re-export of the WMY rollup reader + the linear `aggregateWmyBuckets`
 * composition — no new math. A delta is only computed when both sides carry the
 * same unit, so the result never compares unlike scales. `{ present: false }`
 * when neither side has data.
 */
export async function compareMetric(
  userId: string,
  args: {
    metric: string;
    metricB?: string;
    window?: CoachScopeWindow;
    windowB?: CoachScopeWindow;
    range?: DateRange;
    rangeB?: DateRange;
  },
): Promise<CompareMetricResult> {
  const metricA = resolveRichMetric(args.metric);
  if (!metricA) {
    return { present: false, reason: "unknown_metric" };
  }
  const sideA: SideSpec = { window: args.window, range: args.range };

  const annotateMiss = () =>
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "compare_metric", present: false },
    });

  let mode: "metric_vs_metric" | "window_vs_window";
  let metricB: RichMetric;
  let sideB: SideSpec;

  if (args.metricB) {
    const resolvedB = resolveRichMetric(args.metricB);
    if (!resolvedB) {
      annotateMiss();
      return { present: false, reason: "unknown_metric_b" };
    }
    // Both metrics share side A's horizon (window or range).
    mode = "metric_vs_metric";
    metricB = resolvedB;
    sideB = sideA;
  } else if (args.rangeB || args.windowB) {
    mode = "window_vs_window";
    metricB = metricA;
    sideB = { window: args.windowB, range: args.rangeB };
  } else {
    annotateMiss();
    return { present: false, reason: "specify_metricB_window_or_range" };
  }

  const [a, b] = await Promise.all([
    snapshotSide(userId, metricA, sideA),
    snapshotSide(userId, metricB, sideB),
  ]);

  if (!a || !b) {
    annotateMiss();
    return {
      present: false,
      reason: "no_data",
      mode,
      ...(a ? { a } : {}),
      ...(b ? { b } : {}),
    };
  }

  let delta: { mean: number; pct: number | null } | null = null;
  if (a.unit === b.unit && a.mean !== null && b.mean !== null) {
    const diff = b.mean - a.mean;
    delta = {
      mean: diff,
      pct: a.mean !== 0 ? (diff / Math.abs(a.mean)) * 100 : null,
    };
  }

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "compare_metric", present: true },
  });
  return { present: true, mode, a, b, delta };
}

// ── 3. get_metric_baseline ───────────────────────────────────────────

export interface MetricBaselineResult {
  present: boolean;
  reason?: string;
  metric?: string;
  unit?: string;
  /** The user's personal usual range (median ± k·MAD) + sample transparency. */
  baseline?: { low: number; high: number; sampleDays: number };
  /** Today's latest reading. */
  latest?: number;
  /** Where the latest reading sits relative to the personal band. */
  placement?: "within" | "above" | "below";
  /** Population reference band, or `null` when none exists for the metric. */
  referenceBand?: { low: number; high: number } | null;
  /** The single strongest lagged driver of this metric, or `null`. */
  driver?: { note: string; behaviour: string; outcome: string } | null;
}

/**
 * Return where today's value sits against the user's own usual range. Pure
 * re-export of `buildCoachReadStrip` — the SAME median ± k·MAD baseline engine
 * (`computeVitalsBaseline`) + lagged-driver pick the metric page renders. Below
 * the engine's 7-day history floor the band is not asserted (`{ present: false,
 * reason: "insufficient_history" }`) — never a fabricated range. The population
 * reference band rides along as general context even on a miss.
 */
export async function getMetricBaseline(
  userId: string,
  args: { metric: string },
): Promise<MetricBaselineResult> {
  const metric = resolveRichMetric(args.metric);
  if (!metric) {
    return { present: false, reason: "unknown_metric" };
  }

  const strip = await buildCoachReadStrip(userId, metric.measurementType);

  if (!strip.baseline) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_metric_baseline", present: false },
    });
    return {
      present: false,
      reason: strip.learning ? "insufficient_history" : "no_data",
      metric: metric.label,
      unit: metric.unit,
      referenceBand: metric.band,
    };
  }

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "get_metric_baseline", present: true },
  });
  return {
    present: true,
    metric: metric.label,
    unit: metric.unit,
    baseline: {
      low: strip.baseline.low,
      high: strip.baseline.high,
      sampleDays: strip.baseline.sampleDays,
    },
    latest: strip.baseline.latest,
    placement: strip.baseline.placement,
    referenceBand: metric.band,
    driver: strip.driver,
  };
}

// ── 4. detect_changepoints ───────────────────────────────────────────

export interface Changepoint {
  /** Bucket-start ISO timestamp of the first bucket of the new regime. */
  at: string;
  direction: "increase" | "decrease";
  beforeMean: number;
  afterMean: number;
  delta: number;
}

export interface ChangepointsResult {
  present: boolean;
  reason?: string;
  metric?: string;
  unit?: string;
  granularity?: string;
  windowDays?: number;
  bucketsAnalysed?: number;
  changepoints?: Changepoint[];
}

const MIN_SEGMENT = 5;
/** Mean shift must clear this many series standard deviations to fire. */
const SHIFT_SD_FLOOR = 1.5;
const MAX_CHANGEPOINTS = 5;

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Minimal CUSUM binary-segmentation changepoint detector over a 1-D series.
 *
 * For a segment, the cumulative sum of mean-centred deviations peaks at the most
 * likely split. The split fires ONLY when the resulting mean shift clears a
 * conservative effect-size floor (≥ SHIFT_SD_FLOOR · series SD) and both halves
 * are at least MIN_SEGMENT long — a deliberately high bar so noise does not
 * register (honest-null over false positives). Accepted splits recurse on each
 * half; the result is capped to the strongest MAX_CHANGEPOINTS shifts by the
 * caller.
 *
 * Indices are into the original series. Pure / dependency-free.
 */
function cusumSegment(
  values: number[],
  lo: number,
  hi: number,
  out: Array<{ index: number; beforeMean: number; afterMean: number }>,
): void {
  const n = hi - lo;
  if (n < 2 * MIN_SEGMENT) return;

  const segment = values.slice(lo, hi);
  const segMean = mean(segment);
  const sd = stdDev(segment);
  if (sd <= 0) return;

  // Cumulative sum of mean-centred deviations; track the extreme position.
  let cusum = 0;
  let maxAbs = 0;
  let splitRel = -1;
  for (let i = 0; i < n; i++) {
    cusum += segment[i] - segMean;
    if (Math.abs(cusum) > maxAbs) {
      maxAbs = Math.abs(cusum);
      // The new regime starts at the bucket AFTER the accumulation peak.
      splitRel = i + 1;
    }
  }
  if (splitRel < MIN_SEGMENT || n - splitRel < MIN_SEGMENT) return;

  const before = segment.slice(0, splitRel);
  const after = segment.slice(splitRel);
  const beforeMean = mean(before);
  const afterMean = mean(after);
  if (Math.abs(afterMean - beforeMean) < SHIFT_SD_FLOOR * sd) return;

  out.push({ index: lo + splitRel, beforeMean, afterMean });
  cusumSegment(values, lo, lo + splitRel, out);
  cusumSegment(values, lo + splitRel, hi, out);
}

/**
 * Surface level shifts in a metric over the rollup tier. Reads the trailing
 * window's rollup buckets (`readBestGranularityRollups` — DAY for ≤90 days,
 * coarser for longer windows; the resolved granularity is reported) and runs
 * the minimal CUSUM above over the bucket means. High firing bar — returns
 * `{ present: false }` when too few buckets exist or no shift clears the floor.
 * Re-uses the rollup tier's already-computed bucket means; adds no new
 * persisted analytics.
 */
export async function detectChangepoints(
  userId: string,
  args: { metric: string; window?: CoachScopeWindow; range?: DateRange },
): Promise<ChangepointsResult> {
  const metric = resolveRichMetric(args.metric);
  if (!metric) {
    return { present: false, reason: "unknown_metric" };
  }

  // Either an explicit `{from,to}` range (reach-back + filter) or one of the
  // five fixed trailing windows — both land on the same rollup reader.
  const rangeMs = resolveRangeMs(args.range);
  let windowDays: number;
  let rangeRows: RollupBucketRow[] | null = null;
  let read: Awaited<ReturnType<typeof readBestGranularityRollups>> = null;

  if (rangeMs) {
    windowDays = Math.max(
      1,
      Math.round((rangeMs.toMs - rangeMs.fromMs) / DAY_MS),
    );
    const reachDays = Math.ceil((Date.now() - rangeMs.fromMs) / DAY_MS);
    read =
      Number.isFinite(reachDays) && reachDays > 0
        ? await readBestGranularityRollups(
            userId,
            metric.measurementType,
            reachDays,
          )
        : null;
    rangeRows =
      read?.rows.filter((r) => {
        const t = r.bucketStart.getTime();
        return t >= rangeMs.fromMs && t <= rangeMs.toMs;
      }) ?? null;
  } else {
    windowDays = windowToDays(args.window ?? "last90days");
    read = await readBestGranularityRollups(
      userId,
      metric.measurementType,
      windowDays,
    );
    rangeRows = read?.rows ?? null;
  }

  const miss = (reason: string): ChangepointsResult => {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "detect_changepoints", present: false },
    });
    return {
      present: false,
      reason,
      metric: metric.label,
      unit: metric.unit,
      windowDays,
    };
  };

  if (!read || !rangeRows || rangeRows.length < 2 * MIN_SEGMENT) {
    return miss("insufficient_data");
  }

  const rows = rangeRows;
  const values = rows.map((r) => r.mean);
  const found: Array<{ index: number; beforeMean: number; afterMean: number }> =
    [];
  cusumSegment(values, 0, values.length, found);

  if (found.length === 0) {
    return {
      ...miss("no_changepoint"),
      granularity: read.granularity,
      bucketsAnalysed: values.length,
    };
  }

  const changepoints: Changepoint[] = found
    .sort(
      (x, y) =>
        Math.abs(y.afterMean - y.beforeMean) -
        Math.abs(x.afterMean - x.beforeMean),
    )
    .slice(0, MAX_CHANGEPOINTS)
    .map((cp) => ({
      at: rows[cp.index].bucketStart.toISOString(),
      direction:
        cp.afterMean >= cp.beforeMean
          ? ("increase" as const)
          : ("decrease" as const),
      beforeMean: cp.beforeMean,
      afterMean: cp.afterMean,
      delta: cp.afterMean - cp.beforeMean,
    }))
    .sort((x, y) => (x.at < y.at ? -1 : 1));

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "detect_changepoints", present: true },
  });
  return {
    present: true,
    metric: metric.label,
    unit: metric.unit,
    granularity: read.granularity,
    windowDays,
    bucketsAnalysed: values.length,
    changepoints,
  };
}

// ── 5. get_lab_history (per-analyte trajectory) ──────────────────────

/** One reading on a single analyte's trajectory. */
export interface LabHistoryReading {
  /** Numeric reading; null for a qualitative row (see `valueText`). */
  value: number | null;
  /** Qualitative result text ("negativ" / …); null for a numeric row. */
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** in-range / below / above / unknown — computed from the resolved bounds. */
  rangeStatus: "in-range" | "below" | "above" | "unknown";
  /** Measured date (ISO). */
  takenAt: string;
}

export interface LabHistoryResult {
  present: boolean;
  reason?: string;
  /** The canonical analyte the trajectory resolved to. */
  analyte?: string;
  /** Newest-first readings for this analyte (the requested page). */
  readings?: LabHistoryReading[];
  /** Opaque cursor for the next page; absent when the last page was returned. */
  nextCursor?: string;
}

/** Hard ceiling per page so a heavy panel history never balloons the wire. */
export const LAB_HISTORY_MAX_LIMIT = 50;

/**
 * Return ONE analyte's reading trajectory (newest first) over the user's own
 * lab record. Re-uses the SAME resolver + range classifier the latest-only labs
 * snapshot and the Labs API use (`resolveLabFields` / `classifyReferenceRange`)
 * — no new analytics, no fabricated value. DB-paginated by `offset` so a long
 * history stays token-bounded: the page carries at most `limit` readings and a
 * `nextCursor` when more exist. The encrypted `noteEncrypted` column is never
 * selected, so a decrypted note can never reach the wire. `{ present: false }`
 * when no reading matches the analyte.
 */
export async function getLabHistory(
  userId: string,
  args: { analyte: string; offset?: number; limit?: number },
): Promise<LabHistoryResult> {
  const needle = args.analyte.trim();
  if (!needle) {
    return { present: false, reason: "analyte_required" };
  }
  const offset =
    typeof args.offset === "number" &&
    Number.isFinite(args.offset) &&
    args.offset > 0
      ? Math.floor(args.offset)
      : 0;
  const rawLimit =
    typeof args.limit === "number" &&
    Number.isFinite(args.limit) &&
    args.limit > 0
      ? Math.floor(args.limit)
      : LAB_HISTORY_MAX_LIMIT;
  const limit = Math.min(LAB_HISTORY_MAX_LIMIT, rawLimit);

  // Match the analyte either on the LabResult's own `analyte` column or on the
  // linked Biomarker's canonical name. `take: limit + 1` peeks one row past the
  // page to decide whether a `nextCursor` is warranted. Field-by-field `where`.
  const rows = await prisma.labResult.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [
        { analyte: { contains: needle, mode: "insensitive" } },
        { biomarker: { name: { contains: needle, mode: "insensitive" } } },
      ],
    },
    orderBy: { takenAt: "desc" },
    skip: offset,
    take: limit + 1,
    select: {
      analyte: true,
      panel: true,
      value: true,
      valueText: true,
      unit: true,
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
        },
      },
    },
  });

  if (rows.length === 0) {
    annotate({
      action: { name: "mcp.tool.invoked" },
      meta: { tool: "get_labs", present: false },
    });
    return { present: false, reason: "analyte_not_found" };
  }

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const readings: LabHistoryReading[] = page.map((row) => {
    const resolved = resolveLabFields(row, row.biomarker);
    return {
      value: row.value,
      valueText: row.valueText ? sanitizeValueText(row.valueText) : null,
      unit: resolved.unit,
      referenceLow: resolved.referenceLow,
      referenceHigh: resolved.referenceHigh,
      rangeStatus:
        row.value === null
          ? "unknown"
          : classifyReferenceRange(
              row.value,
              resolved.referenceLow,
              resolved.referenceHigh,
            ),
      takenAt: row.takenAt.toISOString(),
    };
  });

  // Canonical analyte for the trajectory — take the first (newest) resolved row.
  const canonical = resolveLabFields(page[0], page[0].biomarker).analyte;

  annotate({
    action: { name: "mcp.tool.invoked" },
    meta: { tool: "get_labs", present: true },
  });
  return {
    present: true,
    analyte: canonical,
    readings,
    ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + limit) } : {}),
  };
}
