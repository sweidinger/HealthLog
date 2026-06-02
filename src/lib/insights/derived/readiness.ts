/**
 * v1.10.0 — Wellness / readiness index (catalogue metric #7, COMPOSITE).
 *
 * A daily "how recovered are you" proxy, framed as a wellness index, with
 * every contributing component SHOWN. It extends the existing
 * `health-score.ts` weighted-blend + null-redistribution pattern with
 * deviation-from-baseline components:
 *
 *   - **RHR deviation**   — resting HR below/at baseline scores high;
 *                           an elevation suppresses the score.
 *   - **HRV deviation**   — SDNN at/above baseline scores high; a drop
 *                           suppresses it. (Surfaced as "HRV (SDNN)" — it
 *                           is NEVER relabelled RMSSD, and this is never
 *                           called "Recovery".)
 *   - **Sleep adequacy**  — the Sleep Score (#6) folded in as a 0..100
 *                           component (stubbed behind coverage so this
 *                           builds independently and lights up when sleep
 *                           data exists).
 *   - **Respiratory-rate stability** — closeness to the personal baseline.
 *   - **Mood stability**  — the existing mood-aggregate stability score.
 *
 * Each component is 0..100; weights renormalise over the PRESENT components
 * (exactly as the health score redistributes a null pillar). Below the
 * minimum-inputs floor (`minInputs = 2`) it returns `insufficient` — never
 * a headline from 1-of-N. The overnight-HR-return contributor is dropped
 * (needs intra-night HR — absent from the schema).
 *
 * Standard: RHR elevation + HRV suppression as recovery/strain markers —
 * Plews et al. 2013, Sports Medicine 43(9):773–781; Buchheit 2014,
 * Frontiers in Physiology 5:73. Framing: our own heuristic — a daily
 * wellness proxy, NOT a training-recovery score, NOT clinical.
 *
 * Server-only — reads the rollup tier (via the baseline engine) + the
 * sleep score + mood aggregates. The pure blend is exported for tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { computeMoodStability } from "@/lib/insights/mood-aggregates";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { computeVitalsBaseline, type BaselineProfile } from "./baseline";
import { computeSleepScore } from "./sleep-score";
import type { Derived, DerivedProvenanceSource } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
/** Minimum present components before a headline is produced (no 1-of-N). */
export const READINESS_MIN_COMPONENTS = 2;

/** Transparent component weights (renormalised over present components). */
export const READINESS_WEIGHTS = {
  rhr: 0.25,
  hrv: 0.25,
  sleep: 0.25,
  respiratory: 0.1,
  mood: 0.15,
} as const;

export type ReadinessComponentKey = keyof typeof READINESS_WEIGHTS;

/** One readiness contributor the anatomy view ranks by impact. */
export interface ReadinessComponent {
  key: ReadinessComponentKey;
  /** 0..100, or null when the input is missing (drops from the blend). */
  value: number | null;
  /** Effective weight after null-redistribution, 0..1. */
  weight: number;
}

export interface ReadinessValue {
  score: number;
  band: "green" | "yellow" | "red";
  components: ReadinessComponent[];
}

// ── pure deviation scorers (exported for tests) ────────────────────────

function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function bandForScore(score: number): "green" | "yellow" | "red" {
  if (score >= 70) return "green";
  if (score >= 40) return "yellow";
  return "red";
}

/**
 * Map a today-vs-baseline deviation to a 0..100 component score. `spread`
 * is the band half-width (k·MAD·σ-scale from the baseline engine); a value
 * one spread in the "bad" direction lands near 50, two spreads near 0.
 *
 * `direction = "lower-better"` (RHR, respiratory rate): a value above
 * baseline suppresses the score. `direction = "higher-better"` (HRV): a
 * value below baseline suppresses it. On-baseline (or in the good
 * direction) scores 100.
 */
export function scoreDeviation(
  today: number,
  center: number,
  spread: number,
  direction: "lower-better" | "higher-better",
): number {
  if (!Number.isFinite(spread) || spread <= 0) {
    // No usable spread → degrade to a coarse same/above/below.
    if (today === center) return 100;
    const worse =
      direction === "lower-better" ? today > center : today < center;
    return worse ? 50 : 100;
  }
  const worseDelta =
    direction === "lower-better" ? today - center : center - today;
  if (worseDelta <= 0) return 100; // at or in the good direction.
  // 1 spread worse → 50, 2 spreads → 0 (linear).
  return clamp100(100 - (worseDelta / spread) * 50);
}

/**
 * Blend the present components with null-redistribution (the
 * `health-score.ts` pattern). Returns the composite + per-component
 * effective weights for the anatomy view. Pure.
 */
export function blendReadinessComponents(
  raw: Record<ReadinessComponentKey, number | null>,
): { score: number; components: ReadinessComponent[] } {
  const keys = Object.keys(READINESS_WEIGHTS) as ReadinessComponentKey[];
  const present = keys.filter((k) => raw[k] !== null);
  const totalBaseWeight = present.reduce((s, k) => s + READINESS_WEIGHTS[k], 0);
  const components: ReadinessComponent[] = keys.map((k) => ({
    key: k,
    value: raw[k],
    weight:
      raw[k] === null || totalBaseWeight === 0
        ? 0
        : READINESS_WEIGHTS[k] / totalBaseWeight,
  }));
  let composite = 0;
  for (const c of components) {
    if (c.value !== null) composite += c.value * c.weight;
  }
  return { score: clamp100(composite), components };
}

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * The most recent DAY mean for a type within the window — the "today"
 * value the deviation is measured against. Bounded raw read; null when no
 * reading in the window.
 */
async function readLatestDayMean(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: Date,
): Promise<number | null> {
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const rows = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null, measuredAt: { gte: since } },
    orderBy: { measuredAt: "desc" },
    take: 50,
    select: { value: true, measuredAt: true },
  });
  if (rows.length === 0) return null;
  // Derive the most-recent day defensively (do not assume the DB ordering).
  let latestDay = "";
  for (const r of rows) {
    const d = r.measuredAt.toISOString().slice(0, 10);
    if (d > latestDay) latestDay = d;
  }
  const sameDay = rows.filter(
    (r) => r.measuredAt.toISOString().slice(0, 10) === latestDay,
  );
  return sameDay.reduce((s, r) => s + r.value, 0) / sameDay.length;
}

/**
 * Score one baseline-deviation vital component (RHR / HRV / respiratory).
 * Returns null when the baseline is insufficient or there is no recent
 * reading — the component then drops from the blend.
 */
async function scoreVitalDeviation(
  userId: string,
  profile: BaselineProfile,
  type: MeasurementType,
  direction: "lower-better" | "higher-better",
  windowDays: number,
  now: Date,
  coverage: RollupCoverageMap,
): Promise<{ value: number | null; source: DerivedProvenanceSource }> {
  const baseline = await computeVitalsBaseline(userId, profile, {
    type,
    windowDays,
    now,
    coverage,
  });
  if (baseline.status !== "ok") {
    return { value: null, source: baseline.provenance.source };
  }
  const today = await readLatestDayMean(userId, type, windowDays, now);
  if (today == null) {
    return { value: null, source: baseline.provenance.source };
  }
  const value = scoreDeviation(
    today,
    baseline.value.center,
    baseline.value.spread,
    direction,
  );
  return { value, source: baseline.provenance.source };
}

// ── compute ─────────────────────────────────────────────────────────────

export interface ReadinessOpts {
  windowDays?: number;
  now?: Date;
  /** Pre-probed coverage (shared across metrics in one request). */
  coverage?: RollupCoverageMap;
}

/**
 * Compute the wellness/readiness index. Below `READINESS_MIN_COMPONENTS`
 * present components it returns `insufficient` (no 1-of-N headline).
 */
export async function computeReadiness(
  userId: string,
  profile: BaselineProfile,
  opts: ReadinessOpts = {},
): Promise<Derived<ReadinessValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  const coverage = opts.coverage ?? (await probeRollupCoverage(userId));

  const inputNames = [
    "RESTING_HEART_RATE",
    "HEART_RATE_VARIABILITY",
    "SLEEP_DURATION",
    "RESPIRATORY_RATE",
    "MOOD",
  ];

  // Vital deviations (shared coverage map → one probe per request).
  const [rhr, hrv, resp] = await Promise.all([
    scoreVitalDeviation(
      userId,
      profile,
      "RESTING_HEART_RATE",
      "lower-better",
      windowDays,
      now,
      coverage,
    ),
    scoreVitalDeviation(
      userId,
      profile,
      "HEART_RATE_VARIABILITY",
      "higher-better",
      windowDays,
      now,
      coverage,
    ),
    scoreVitalDeviation(
      userId,
      profile,
      "RESPIRATORY_RATE",
      "lower-better",
      windowDays,
      now,
      coverage,
    ),
  ]);

  // Sleep adequacy — folds the Sleep Score in (stubbed behind coverage:
  // null when there is no scorable night, dropping the component).
  const sleep = await computeSleepScore(userId, profile, { windowDays, now });
  const sleepValue = sleep.status === "ok" ? sleep.value.score : null;

  // Mood stability — reuse the shipped mood-aggregate stability score over
  // the window's daily means.
  const moodValue = await readMoodStability(userId, windowDays, now);

  const raw: Record<ReadinessComponentKey, number | null> = {
    rhr: rhr.value,
    hrv: hrv.value,
    sleep: sleepValue,
    respiratory: resp.value,
    mood: moodValue,
  };

  const { score, components } = blendReadinessComponents(raw);
  const presentCount = components.filter((c) => c.value !== null).length;
  const missing = components
    .filter((c) => c.value === null)
    .map((c) => c.key);

  // Provenance source: DAY when any vital read the rollup tier, else live.
  const anyDay = [rhr.source, hrv.source, resp.source].includes("DAY");
  const source: DerivedProvenanceSource =
    presentCount === 0 ? "none" : anyDay ? "DAY" : "live";

  if (presentCount < READINESS_MIN_COMPONENTS) {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: components.length,
      presentInputs: presentCount,
      historyDays: 0,
      missing,
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<ReadinessValue>({
      coverage: cov,
      provenance: { inputs: inputNames, source, windowDays, computedAt },
      reason: "insufficient_components",
    });
  }

  const { coverage: cov, confidence } = deriveCoverage({
    requiredInputs: components.length,
    presentInputs: presentCount,
    historyDays: windowDays,
    missing,
    fullHistoryDays: windowDays,
  });

  const presentInputNames = inputNames.filter((_, i) => {
    const key = (
      ["rhr", "hrv", "sleep", "respiratory", "mood"] as ReadinessComponentKey[]
    )[i];
    return raw[key] !== null;
  });

  return buildOk<ReadinessValue>({
    value: { score, band: bandForScore(score), components },
    coverage: cov,
    confidence,
    provenance: {
      inputs: presentInputNames.length > 0 ? presentInputNames : inputNames,
      source,
      windowDays,
      computedAt,
    },
  });
}

/**
 * Mood stability over the window — reads daily-mean mood and feeds the
 * shipped `computeMoodStability` (0..100, higher = steadier). Null below
 * the stability floor.
 */
async function readMoodStability(
  userId: string,
  windowDays: number,
  now: Date,
): Promise<number | null> {
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const rows = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "asc" },
    take: 2000,
    select: { score: true, moodLoggedAt: true },
  });
  if (rows.length === 0) return null;
  // Collapse to daily means keyed by dayOffset (newest = 0), matching the
  // mood-aggregate DailyPoint shape.
  const byDay = new Map<number, { sum: number; count: number }>();
  for (const r of rows) {
    const offset = Math.floor(
      (now.getTime() - r.moodLoggedAt.getTime()) / MS_PER_DAY,
    );
    const acc = byDay.get(offset) ?? { sum: 0, count: 0 };
    acc.sum += r.score;
    acc.count += 1;
    byDay.set(offset, acc);
  }
  const daily = [...byDay.entries()].map(([dayOffset, acc]) => ({
    dayOffset,
    value: acc.sum / acc.count,
  }));
  const stability = computeMoodStability(daily);
  return stability ? stability.score : null;
}
