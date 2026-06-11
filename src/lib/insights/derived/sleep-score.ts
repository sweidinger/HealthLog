/**
 * v1.10.0 — transparent Sleep Score (catalogue metric #6, COMPOSITE).
 *
 * A 0–100 sleep-quality composite whose sub-scores are SHOWN, not a black
 * box. Built from the per-stage `SLEEP_DURATION` rows HealthKit + Withings
 * write (one row per stage per night, `value` in minutes, `sleepStage` ∈
 * { IN_BED, AWAKE, ASLEEP, REM, CORE, DEEP }). Combines:
 *
 *   - **Sufficiency** = total asleep minutes vs an age-based need target
 *     (Hirshkowitz et al. 2015 National Sleep Foundation recommendations).
 *   - **Efficiency**  = asleep ÷ in-bed minutes (AASM scoring convention;
 *     ≥ 85 % is the clinical "good" floor).
 *   - **Consistency** = SD of the sleep midpoint across the window (lower
 *     is better) — a regularity proxy.
 *   - **Composition** = REM% + Deep% of total asleep vs Ohayon et al. 2017
 *     age norms.
 *
 * Each sub-score is 0..100 with its own transparent weight; the composite
 * **reweights around missing sub-scores** exactly as `health-score.ts`
 * null-redistributes (a legacy `ASLEEP`-only night yields Sufficiency +
 * Efficiency + Consistency + Timing, dropping Composition gracefully — it
 * is never fabricated). Restfulness / Restoration are NOT derivable (no
 * per-stage HR, no WASO timestamps) and are omitted, not faked.
 *
 * Standard: AASM scoring conventions (efficiency); Hirshkowitz et al. 2015,
 * Sleep Health 1(1):40–43 (age-based duration need); Ohayon et al. 2017,
 * Sleep Health 3(1):6–19 (stage-percentage norms by age). Framing
 * discipline: consumer sleep-staging vs PSG is only moderately accurate —
 * the copy stays directional, never clinical.
 *
 * Server-only — reads raw `SLEEP_DURATION` rows via Prisma (per-stage rows
 * are not rolled up by stage, so the night reconstruction reads raw, but
 * bounded to the window). The pure scorers are exported for unit tests.
 */
import type { MeasurementType, SleepStage } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import type { BaselineProfile } from "./baseline";
import type { Derived } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Default trailing window for the consistency/timing baseline (days). */
const DEFAULT_WINDOW_DAYS = 30;
/** A night needs ≥ this many stage rows to score at all. */
const MIN_STAGE_ROWS_PER_NIGHT = 1;

/** Transparent sub-score weights (shown to the user, sum to 1 over present). */
export const SLEEP_SUBSCORE_WEIGHTS = {
  sufficiency: 0.3,
  efficiency: 0.25,
  consistency: 0.2,
  timing: 0.1,
  composition: 0.15,
} as const;

export type SleepSubScoreKey = keyof typeof SLEEP_SUBSCORE_WEIGHTS;

/** One sub-score row the anatomy view renders as a contributor. */
export interface SleepSubScore {
  key: SleepSubScoreKey;
  /** 0..100, or null when the night lacks the inputs (drops from the blend). */
  value: number | null;
  /** Effective weight after null-redistribution, 0..1. */
  weight: number;
}

export interface SleepScoreValue {
  /** The composite 0..100. */
  score: number;
  /** Band derived from the score (green/yellow/red). */
  band: "green" | "yellow" | "red";
  /** The night this score describes (YYYY-MM-DD of the wake day). */
  night: string;
  /** Total asleep minutes that night. */
  asleepMinutes: number;
  /** Total in-bed minutes that night (asleep + awake-in-bed), when known. */
  inBedMinutes: number | null;
  /** The transparent sub-scores (present + dropped). */
  subScores: SleepSubScore[];
  /** Nights in the window that backed the consistency/timing baseline. */
  windowNights: number;
}

const ASLEEP_STAGES: ReadonlySet<SleepStage> = new Set<SleepStage>([
  "ASLEEP",
  "REM",
  "CORE",
  "DEEP",
]);

// ── pure scorers (exported for tests) ─────────────────────────────────

/**
 * Age-based sleep-need target in minutes (National Sleep Foundation,
 * Hirshkowitz et al. 2015). Adult default 7–9 h; we anchor the target at
 * the lower-recommended bound so hitting it scores 100.
 */
export function sleepNeedMinutes(ageYears: number | null): number {
  if (ageYears == null || !Number.isFinite(ageYears)) return 7 * 60; // adult default
  if (ageYears < 1) return 14 * 60;
  if (ageYears < 3) return 12 * 60;
  if (ageYears < 6) return 11 * 60;
  if (ageYears < 14) return 10 * 60;
  if (ageYears < 18) return 9 * 60;
  if (ageYears < 65) return 7 * 60;
  return 7 * 60; // 65+ NSF recommends 7–8 h
}

/** Sufficiency: asleep vs need, capped at 100 (oversleep is not penalised). */
export function scoreSufficiency(
  asleepMinutes: number,
  needMinutes: number,
): number | null {
  if (needMinutes <= 0) return null;
  return clamp100((asleepMinutes / needMinutes) * 100);
}

/**
 * Efficiency: asleep ÷ in-bed (AASM convention; ≥ 85 % is the clinical
 * "good" floor). Null when in-bed is unknown (legacy nights with only asleep
 * stages and no IN_BED row).
 *
 * Overlap handling: HealthKit can report ASLEEP-class stages whose summed
 * minutes exceed the explicit IN_BED total when stages overlap (the watch
 * writes per-sample stage rows and an IN_BED block that don't tile cleanly).
 * Treating that as a real ratio yields efficiency > 100 %, which a blind
 * `clamp(…, 100)` would silently swallow as a perfect night and hide the
 * data problem. Instead, treat asleep > in-bed as the impossible-overlap case
 * it is: cap efficiency at 100 % (asleep cannot exceed time in bed) but only
 * when the overshoot is within a small tolerance — a gross overshoot signals
 * a malformed night with no trustworthy in-bed denominator, so we drop the
 * sub-score (null) rather than report a fabricated 100.
 */
export function scoreEfficiency(
  asleepMinutes: number,
  inBedMinutes: number | null,
): number | null {
  if (inBedMinutes == null || inBedMinutes <= 0) return null;
  const pct = (asleepMinutes / inBedMinutes) * 100;
  if (pct > 100) {
    // A small overshoot (≤ 5 %) is rounding / stage-boundary noise — asleep
    // cannot truly exceed in-bed, so cap at the AASM ceiling of 100. A larger
    // overshoot means the in-bed total is not a usable denominator; the night
    // has no honest efficiency, so it drops from the blend.
    const EFFICIENCY_OVERSHOOT_TOLERANCE = 105;
    return pct <= EFFICIENCY_OVERSHOOT_TOLERANCE ? 100 : null;
  }
  return clamp100(pct);
}

/**
 * Composition: how close REM% + Deep% sit to the age-typical band
 * (Ohayon et al. 2017). Adults: REM ≈ 20–25 %, Deep ≈ 13–23 % of total
 * asleep. We score the combined REM+Deep fraction against a 33–48 % target
 * window — inside → 100, falling off linearly outside. Null when no stage
 * breakdown exists (a legacy `ASLEEP`-only night).
 */
export function scoreComposition(
  remMinutes: number,
  deepMinutes: number,
  asleepMinutes: number,
  hasStageBreakdown: boolean,
): number | null {
  if (!hasStageBreakdown || asleepMinutes <= 0) return null;
  const fraction = (remMinutes + deepMinutes) / asleepMinutes;
  const lo = 0.33;
  const hi = 0.48;
  if (fraction >= lo && fraction <= hi) return 100;
  // Linear fall-off: half a window-width away from the band → 0.
  const halfWidth = (hi - lo) / 2 + 0.15;
  const dist = fraction < lo ? lo - fraction : fraction - hi;
  return clamp100(100 * (1 - dist / halfWidth));
}

const MINUTES_PER_DAY = 1440;

/**
 * Shortest distance between two minutes-of-day on the 24-hour clock, treating
 * the day as circular (mod 1440). A midpoint at 23:50 (1430) and one at 00:10
 * (10) are 20 minutes apart, NOT 1420 — the linear difference inflates timing
 * SD and distance for sleepers whose midpoint straddles midnight (and on a DST
 * shift). Pure.
 */
export function circularMinuteDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(raw, MINUTES_PER_DAY - raw);
}

/**
 * Circular mean of minutes-of-day via the mean resultant vector (the standard
 * directional-statistics circular mean) — averaging clock minutes linearly
 * collapses a midnight-straddling cluster to noon. Returns null on an empty
 * input or a near-zero resultant (no defined mean direction). Pure.
 */
export function circularMeanMinutes(minutes: number[]): number | null {
  if (minutes.length === 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  for (const m of minutes) {
    const angle = (m / MINUTES_PER_DAY) * 2 * Math.PI;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }
  if (Math.abs(sumSin) < 1e-9 && Math.abs(sumCos) < 1e-9) return null;
  let meanAngle = Math.atan2(sumSin, sumCos);
  if (meanAngle < 0) meanAngle += 2 * Math.PI;
  return (meanAngle / (2 * Math.PI)) * MINUTES_PER_DAY;
}

/**
 * Consistency: lower circular SD of the sleep midpoint (minutes-of-day)
 * across the window → higher score. A 90-min SD maps to 0, a 0-min SD to 100.
 * Null below 3 nights (no variance signal). The SD is computed against the
 * CIRCULAR mean using circular distance so a midnight-straddling sleeper is
 * not penalised for a spurious ~24-hour spread.
 */
export function scoreConsistency(midpointMinutes: number[]): number | null {
  if (midpointMinutes.length < 3) return null;
  const mean = circularMeanMinutes(midpointMinutes);
  if (mean == null) return null;
  const variance =
    midpointMinutes.reduce(
      (s, v) => s + circularMinuteDistance(v, mean) ** 2,
      0,
    ) / midpointMinutes.length;
  const sd = Math.sqrt(variance);
  const FULL_SCALE = 90; // minutes — beyond this the rhythm reads erratic.
  return clamp100(100 * (1 - Math.min(sd, FULL_SCALE) / FULL_SCALE));
}

/**
 * Timing: this night's midpoint vs the user's habitual midpoint (the window
 * circular mean). On-target → 100; 90 min off → 0. Null when the habitual
 * window is not yet established (< 3 nights). Uses circular distance so a
 * midnight-straddling night is measured by its true clock offset.
 */
export function scoreTiming(
  nightMidpoint: number | null,
  habitualMidpoint: number | null,
  windowNights: number,
): number | null {
  if (nightMidpoint == null || habitualMidpoint == null || windowNights < 3) {
    return null;
  }
  const FULL_SCALE = 90;
  const dist = circularMinuteDistance(nightMidpoint, habitualMidpoint);
  return clamp100(100 * (1 - Math.min(dist, FULL_SCALE) / FULL_SCALE));
}

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
 * Blend the present sub-scores with null-redistribution (the
 * `health-score.ts` pattern). Returns the composite + the per-sub-score
 * effective weights for the anatomy view. Pure.
 */
export function blendSleepSubScores(
  raw: Record<SleepSubScoreKey, number | null>,
): { score: number; subScores: SleepSubScore[] } {
  const keys = Object.keys(SLEEP_SUBSCORE_WEIGHTS) as SleepSubScoreKey[];
  const present = keys.filter((k) => raw[k] !== null);
  const totalBaseWeight = present.reduce(
    (s, k) => s + SLEEP_SUBSCORE_WEIGHTS[k],
    0,
  );
  const subScores: SleepSubScore[] = keys.map((k) => ({
    key: k,
    value: raw[k],
    weight:
      raw[k] === null || totalBaseWeight === 0
        ? 0
        : SLEEP_SUBSCORE_WEIGHTS[k] / totalBaseWeight,
  }));
  let composite = 0;
  for (const s of subScores) {
    if (s.value !== null) composite += s.value * s.weight;
  }
  return { score: clamp100(composite), subScores };
}

// ── night reconstruction ───────────────────────────────────────────────

interface SleepRow {
  value: number;
  measuredAt: Date;
  sleepStage: SleepStage | null;
}

export interface NightSummary {
  /** Wake-day key (YYYY-MM-DD) the night is filed under. */
  night: string;
  asleepMinutes: number;
  awakeMinutes: number;
  remMinutes: number;
  deepMinutes: number;
  inBedMinutes: number | null;
  hasStageBreakdown: boolean;
  /** Midpoint as minutes-of-day (0..1439), or null when timestamps collapse. */
  midpoint: number | null;
}

/**
 * Group raw stage rows into per-night summaries. A "night" is keyed by the
 * latest stage row's calendar day (the wake day). Pure — the caller does
 * the bounded DB read and passes rows in.
 *
 * `tz` is the IANA zone the midpoint is expressed against: a sleeper's
 * 03:00-local midpoint must read as minutes-of-day in THEIR wall clock, not
 * UTC, so a non-UTC user's consistency / timing sub-scores don't drift with
 * the offset. Defaults to UTC for back-compatible pure use.
 */
export function reconstructNights(
  rows: SleepRow[],
  tz: string = "UTC",
): NightSummary[] {
  // Bucket rows by the wake-day key (UTC day of the row's measuredAt).
  const byNight = new Map<string, SleepRow[]>();
  for (const row of rows) {
    const key = row.measuredAt.toISOString().slice(0, 10);
    const list = byNight.get(key) ?? [];
    list.push(row);
    byNight.set(key, list);
  }
  const nights: NightSummary[] = [];
  for (const [night, nightRows] of byNight) {
    let asleep = 0;
    let awake = 0;
    let rem = 0;
    let deep = 0;
    let inBed = 0;
    let sawInBed = false;
    let sawStageBreakdown = false;
    let earliest = Infinity;
    let latest = -Infinity;
    for (const r of nightRows) {
      const stage = r.sleepStage;
      const minutes = Number.isFinite(r.value) ? r.value : 0;
      const t = r.measuredAt.getTime();
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
      if (stage === "IN_BED") {
        inBed += minutes;
        sawInBed = true;
        continue;
      }
      if (stage === "AWAKE") {
        awake += minutes;
        continue;
      }
      if (stage && ASLEEP_STAGES.has(stage)) {
        asleep += minutes;
        if (stage === "REM") rem += minutes;
        if (stage === "DEEP") deep += minutes;
        if (stage === "REM" || stage === "CORE" || stage === "DEEP") {
          sawStageBreakdown = true;
        }
      } else if (stage == null) {
        // A bare SLEEP_DURATION row (no stage) is the night's total asleep.
        asleep += minutes;
      }
    }
    // In-bed = explicit IN_BED rows when present, else asleep + awake.
    const inBedMinutes = sawInBed ? inBed : awake > 0 ? asleep + awake : null;
    const midpoint =
      Number.isFinite(earliest) && Number.isFinite(latest) && latest > earliest
        ? minutesOfDay(new Date((earliest + latest) / 2), tz)
        : null;
    nights.push({
      night,
      asleepMinutes: asleep,
      awakeMinutes: awake,
      remMinutes: rem,
      deepMinutes: deep,
      inBedMinutes,
      hasStageBreakdown: sawStageBreakdown,
      midpoint,
    });
  }
  return nights.sort((a, b) => (a.night < b.night ? -1 : 1));
}

function minutesOfDay(d: Date, tz: string): number {
  if (tz === "UTC") return d.getUTCHours() * 60 + d.getUTCMinutes();
  const { hour, minute } = wallClockInTz(d, tz);
  return hour * 60 + minute;
}

// ── compute ─────────────────────────────────────────────────────────────

export interface SleepScoreOpts {
  windowDays?: number;
  now?: Date;
  /**
   * IANA zone the sleep midpoint is expressed against. Omit to resolve the
   * user's stored zone (the production path); pass explicitly in tests.
   */
  tz?: string;
}

/**
 * Compute the Sleep Score for the most recent night, using the trailing
 * window for the consistency/timing baseline. Returns `insufficient` when
 * no scorable night exists in the window.
 */
export async function computeSleepScore(
  userId: string,
  profile: BaselineProfile,
  opts: SleepScoreOpts = {},
): Promise<Derived<SleepScoreValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  // The midpoint is the user's wall-clock minutes-of-day, not UTC's, so a
  // non-UTC sleeper's consistency / timing sub-scores don't drift with the
  // offset. Resolve the stored zone unless a caller pins one.
  const tz = opts.tz ?? (await resolveUserTimezone(userId));
  const inputs = ["SLEEP_DURATION"];
  const required = 1;
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);

  const rows = (await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION" satisfies MeasurementType,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true, measuredAt: true, sleepStage: true },
  })) as SleepRow[];

  if (rows.length === 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: required,
      presentInputs: 0,
      historyDays: 0,
      missing: inputs,
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<SleepScoreValue>({
      coverage,
      provenance: { inputs, source: "none", windowDays, computedAt },
      reason: "no_sleep_in_window",
    });
  }

  const nights = reconstructNights(rows, tz).filter(
    (n) => n.asleepMinutes > 0,
  );
  const scorableNights = nights.filter(
    (n) => countNightRows(rows, n.night) >= MIN_STAGE_ROWS_PER_NIGHT,
  );

  if (scorableNights.length === 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: required,
      presentInputs: 0,
      historyDays: 0,
      missing: inputs,
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<SleepScoreValue>({
      coverage,
      provenance: { inputs, source: "live", windowDays, computedAt },
      reason: "no_scorable_night",
    });
  }

  const latest = scorableNights[scorableNights.length - 1];
  const midpoints = scorableNights
    .map((n) => n.midpoint)
    .filter((m): m is number => m != null);
  // Circular mean (mod 1440) so a midnight-straddling sleeper's habitual
  // midpoint is not dragged to noon by a linear average.
  const habitualMidpoint = circularMeanMinutes(midpoints);

  const needMinutes = sleepNeedMinutes(profile.ageYears);

  const raw: Record<SleepSubScoreKey, number | null> = {
    sufficiency: scoreSufficiency(latest.asleepMinutes, needMinutes),
    efficiency: scoreEfficiency(latest.asleepMinutes, latest.inBedMinutes),
    consistency: scoreConsistency(midpoints),
    timing: scoreTiming(latest.midpoint, habitualMidpoint, midpoints.length),
    composition: scoreComposition(
      latest.remMinutes,
      latest.deepMinutes,
      latest.asleepMinutes,
      latest.hasStageBreakdown,
    ),
  };

  const { score, subScores } = blendSleepSubScores(raw);
  const presentCount = subScores.filter((s) => s.value !== null).length;
  const missing = subScores
    .filter((s) => s.value === null)
    .map((s) => s.key);

  const { coverage, confidence } = deriveCoverage({
    // Coverage here is "sub-scores present / total possible" — the
    // composite's input axis is its five sub-scores, not the single
    // SLEEP_DURATION stream.
    requiredInputs: subScores.length,
    presentInputs: presentCount,
    historyDays: scorableNights.length,
    missing,
    fullHistoryDays: windowDays,
  });

  return buildOk<SleepScoreValue>({
    value: {
      score,
      band: bandForScore(score),
      night: latest.night,
      asleepMinutes: latest.asleepMinutes,
      inBedMinutes: latest.inBedMinutes,
      subScores,
      windowNights: scorableNights.length,
    },
    coverage,
    confidence,
    provenance: {
      inputs,
      source: "live",
      windowDays,
      computedAt,
    },
  });
}

function countNightRows(rows: SleepRow[], night: string): number {
  let c = 0;
  for (const r of rows) {
    if (r.measuredAt.toISOString().slice(0, 10) === night) c += 1;
  }
  return c;
}
