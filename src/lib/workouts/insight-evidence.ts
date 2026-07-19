/**
 * The deterministic evidence block behind the per-workout Activity Insight.
 *
 * Everything the model is ever told about a session is built here, and the
 * shape of this module is the security boundary of the whole feature: it is a
 * NUMBERS-ONLY projection over closed fields. `Workout.metadata` is a JSON blob
 * carrying device bundle ids, HKWorkoutEvent markers and per-vendor extras —
 * free text the user never wrote and we never reviewed. None of it reaches a
 * prompt. The one non-numeric field that survives, `sportType`, is narrowed
 * against the closed `workoutSportTypeEnum` first, so even a hand-inserted row
 * with a crafted sport string projects as `"other"`.
 *
 * The consequence worth stating plainly: there is no injection surface here to
 * defend, because there is no attacker-controlled text in the payload at all.
 * That is a property of this file, and it is why the workout coach launch does
 * not need the fenced endpoint the document surfaces use.
 *
 * Determinism is the second contract. The same session always projects to the
 * same numbers, which is what makes the input hash a real no-op gate: a WHOOP
 * re-sync or an iOS `stats:` overwrite that changes nothing the paragraph
 * narrates hashes identically and never reaches a provider.
 */
import { userDayKey } from "@/lib/tz/format";
import { workoutSportTypeEnum } from "@/lib/validations/workout";
import type { WorkoutHrSeries } from "./hr-series";
import type { WorkoutZones } from "./zones";

/** Lookback for the own-history comparison, in days. */
export const OWN_HISTORY_LOOKBACK_DAYS = 90;

/** Cap on the history rows the median reads — bounded work on a heavy account. */
export const OWN_HISTORY_MAX_ROWS = 400;

/**
 * The shape of the session's heart rate, reduced to four figures.
 *
 * Derived from the SAME series the detail route renders (`buildWorkoutHrSeries`),
 * deliberately not from `loadIntradayPulse`: that read is day-scoped, so it
 * would answer a question about the day rather than about the session, and the
 * workout-window series is the richer of the two anyway.
 */
export interface WorkoutHrShape {
  source: WorkoutHrSeries["source"];
  bucketSec: number;
  buckets: number;
  /** Mean bpm across the first half of the session's buckets. */
  firstHalfMeanBpm: number;
  /** Mean bpm across the second half. */
  secondHalfMeanBpm: number;
  /** secondHalf − firstHalf. Positive = drifting up as the session went on. */
  driftBpm: number;
  /** Buckets that stand out as a local high point (see `countPeaks`). */
  peaks: number;
  /**
   * Median seconds from a peak back down to the session's mean. Null when no
   * peak ever came back down inside the session.
   */
  medianSettleSec: number | null;
}

/** The user's own recent baseline for this sport. Medians, never means. */
export interface WorkoutOwnHistory {
  lookbackDays: number;
  /** Comparable sessions found, excluding this one. */
  sampleSize: number;
  medianDurationSec: number;
  medianAvgHr: number | null;
  medianDistanceM: number | null;
  medianEnergyKcal: number | null;
}

export interface WorkoutInsightEvidence {
  /** Narrowed against the closed enum — never the raw column. */
  sportType: string;
  /** User-profile-timezone day the session started. */
  localDate: string;
  durationSec: number;
  distanceM: number | null;
  /** Metres climbed, from route altitudes when present, else the column. */
  climbM: number | null;
  activeEnergyKcal: number | null;
  avgHr: number | null;
  maxHr: number | null;
  minHr: number | null;
  /** Seconds in each %HRmax (or device) zone, ascending by zone. */
  zoneSeconds: { zone: number; seconds: number }[] | null;
  hr: WorkoutHrShape | null;
  history: WorkoutOwnHistory | null;
}

/**
 * Narrow the stored sport string to the closed vocabulary.
 *
 * The DB column is free text by design (a new sport is one Zod refinement
 * away), so this is the whitelist that keeps an unreviewed value out of the
 * prompt. Anything unrecognised projects as `"other"` — the same bucket the
 * ingest validator uses.
 */
export function narrowSportType(raw: string): string {
  const parsed = workoutSportTypeEnum.safeParse(raw);
  return parsed.success ? parsed.data : "other";
}

function median(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

/**
 * Count the session's peaks.
 *
 * A peak is a bucket that is both a strict local maximum against its
 * neighbours AND at or above the 90th percentile of the session's bucket
 * means. Requiring both is what keeps a steady ride from reporting fifty
 * "peaks" out of ordinary sampling noise, and what keeps an interval session
 * from reporting one.
 */
function countPeaks(means: number[], threshold: number): number[] {
  const indices: number[] = [];
  for (let i = 1; i < means.length - 1; i++) {
    if (
      means[i] >= threshold &&
      means[i] > means[i - 1] &&
      means[i] >= means[i + 1]
    ) {
      indices.push(i);
    }
  }
  return indices;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[idx];
}

/**
 * Reduce the HR curve to the four figures the paragraph can honestly use.
 *
 * Returns null below three buckets: two points cannot carry a front/back-half
 * comparison, and inventing one from them is exactly the overclaiming the copy
 * contract forbids.
 */
export function summariseHrShape(
  series: WorkoutHrSeries | null,
): WorkoutHrShape | null {
  if (!series || series.points.length < 3) return null;

  const means = series.points.map((p) => p.mean);
  const half = Math.floor(means.length / 2);
  const avg = (xs: number[]) =>
    Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;

  const firstHalfMeanBpm = avg(means.slice(0, half));
  const secondHalfMeanBpm = avg(means.slice(means.length - half));
  const sessionMean = avg(means);

  const sorted = [...means].sort((a, b) => a - b);
  const peakIndices = countPeaks(means, percentile(sorted, 0.9));

  // Settle time: from each peak, how long until the curve first comes back to
  // the session's own mean. A peak that never settles inside the session
  // contributes nothing rather than a censored figure pretending to be one.
  const settles: number[] = [];
  for (const idx of peakIndices) {
    for (let j = idx + 1; j < means.length; j++) {
      if (means[j] <= sessionMean) {
        settles.push((j - idx) * series.bucketSec);
        break;
      }
    }
  }

  return {
    source: series.source,
    bucketSec: series.bucketSec,
    buckets: series.points.length,
    firstHalfMeanBpm,
    secondHalfMeanBpm,
    driftBpm: Math.round((secondHalfMeanBpm - firstHalfMeanBpm) * 10) / 10,
    peaks: peakIndices.length,
    medianSettleSec: settles.length > 0 ? median(settles) : null,
  };
}

/**
 * Total metres climbed, summed from a GeoJSON LineString's altitude channel.
 *
 * Only positive deltas count — this is climb, not net elevation change, which
 * is the figure a rider recognises. Returns null when the geometry carries no
 * altitude channel at all (Withings ships static GPX without one), so the
 * caller can fall back to the denormalised column instead of reporting a
 * confident zero.
 */
export function routeClimbM(geometry: unknown): number | null {
  if (!geometry || typeof geometry !== "object") return null;
  const coords = (geometry as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords)) return null;

  let climb = 0;
  let previous: number | null = null;
  let seen = 0;
  for (const point of coords) {
    if (!Array.isArray(point) || point.length < 3) continue;
    const alt = point[2];
    if (typeof alt !== "number" || !Number.isFinite(alt)) continue;
    seen++;
    if (previous !== null && alt > previous) climb += alt - previous;
    previous = alt;
  }
  return seen >= 2 ? Math.round(climb) : null;
}

/** Slim row shape the own-history median reads. */
export interface OwnHistoryRow {
  durationSec: number;
  avgHeartRate: number | null;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
}

/**
 * The user's own median for this sport over the lookback window.
 *
 * Medians rather than means because a single six-hour outing would drag a mean
 * far enough that the paragraph's comparison would be wrong in the ordinary
 * case. Returns null below three comparable sessions: two sessions do not make
 * a baseline, and the copy contract says so plainly instead.
 */
export function summariseOwnHistory(
  rows: readonly OwnHistoryRow[],
): WorkoutOwnHistory | null {
  if (rows.length < 3) return null;
  const durations = rows.map((r) => r.durationSec);
  const medianDurationSec = median(durations);
  if (medianDurationSec === null) return null;

  const numeric = (pick: (r: OwnHistoryRow) => number | null): number[] =>
    rows
      .map(pick)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  return {
    lookbackDays: OWN_HISTORY_LOOKBACK_DAYS,
    sampleSize: rows.length,
    medianDurationSec: Math.round(medianDurationSec),
    medianAvgHr: median(numeric((r) => r.avgHeartRate)),
    medianDistanceM: median(numeric((r) => r.totalDistanceM)),
    medianEnergyKcal: median(numeric((r) => r.totalEnergyKcal)),
  };
}

/** The already-loaded workout row the projection reads. */
export interface WorkoutEvidenceRow {
  sportType: string;
  startedAt: Date;
  durationSec: number;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  elevationM: number | null;
}

export interface BuildEvidenceInput {
  row: WorkoutEvidenceRow;
  tz: string;
  /** The detail route's HR curve for this workout, or null. */
  hrSeries: WorkoutHrSeries | null;
  /** Zones as the detail route computes them, or null. */
  zones: WorkoutZones | null;
  /** `WorkoutRoute.geometry`, or null when the source shipped no route. */
  routeGeometry: unknown;
  /** Same-sport sessions inside the lookback, excluding this workout. */
  history: readonly OwnHistoryRow[];
}

/**
 * Compose the evidence block. Pure — every read has already happened.
 */
export function buildWorkoutInsightEvidence(
  input: BuildEvidenceInput,
): WorkoutInsightEvidence {
  const { row } = input;
  return {
    sportType: narrowSportType(row.sportType),
    localDate: userDayKey(row.startedAt, input.tz),
    durationSec: row.durationSec,
    distanceM: row.totalDistanceM,
    climbM: routeClimbM(input.routeGeometry) ?? row.elevationM,
    activeEnergyKcal: row.totalEnergyKcal,
    avgHr: row.avgHeartRate,
    maxHr: row.maxHeartRate,
    minHr: row.minHeartRate,
    zoneSeconds:
      input.zones?.zones.map((z) => ({ zone: z.zone, seconds: z.seconds })) ??
      null,
    hr: summariseHrShape(input.hrSeries),
    history: summariseOwnHistory(input.history),
  };
}
