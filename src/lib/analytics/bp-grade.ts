/**
 * v1.15.12 A1 — graded blood-pressure pillar score.
 *
 * The Personal Health Score's BP pillar previously equalled
 * `bpInTargetRate`: the share of paired readings where BOTH systolic and
 * diastolic sat at-or-below the age-band ceiling, scored binary per
 * reading over the all-time window. That metric is honest as a "% of
 * readings in range" stat, but it is the wrong thing to use AS the
 * pillar score: a user who averages 134/87 (borderline stage-1, every
 * reading slightly over the diastolic ceiling) collapses to ~10-16/100
 * because nearly every reading fails the binary check — even though
 * clinically they are "a bit high", not catastrophic. Improvement also
 * never shows, because the rate is all-time and a binary cliff.
 *
 * This module replaces the binary rate AS THE SCORE with a smooth
 * clinical-proximity grade. A representative BP (recency-weighted toward
 * the last weeks) is mapped to a 0-100 score per axis, and the pillar
 * takes the WORSE of the two sub-scores — so an elevated diastolic
 * counts against the score (it should) without binary-zeroing it.
 *
 * The curve is anchored on the SAME age-band ceiling the rest of the app
 * uses (`BpTargets.sysHigh` / `diaHigh` from `bp-targets.ts`). No new
 * thresholds are invented; the score bands are derived as offsets from
 * the configured ceiling:
 *
 *   offset from ceiling   →  axis score
 *   ≤ −12 (well below)        100  (optimal — comfortably in band)
 *      0  (at the ceiling)     85  (at goal — "well controlled")
 *     +5                       65
 *    +10                       52
 *    +20                       40
 *    +40                       18
 *    ≥ +60                      5  (far above — uncontrolled)
 *
 * Piecewise-linear between anchors — no hard cliffs, so a one-mmHg
 * change moves the score by a small, continuous amount. The diastolic
 * and systolic axes share the same offset→score table, so each axis is
 * judged against its own ceiling.
 *
 * Hypotension is penalised symmetrically: below the clinical floors
 * (`sys ≥ 90`, `dia ≥ 50`, mirroring `isBpReadingInTarget`) the distance
 * below the floor is fed through the same over-target curve, so a
 * symptomatically low reading scores like an equally-distant high one
 * rather than reading as "perfect".
 *
 * Pure & deterministic — fully unit-tested in `__tests__/bp-grade.test.ts`.
 */
import type { BpTargets } from "./bp-targets";
import {
  SYS_HYPOTENSION_FLOOR,
  DIA_HYPOTENSION_FLOOR,
} from "./bp-in-target";

/**
 * Offset-from-ceiling → axis-score anchors. Offsets are in mmHg; the
 * first anchor is the "optimal" plateau (comfortably below the ceiling),
 * the last is the "uncontrolled" floor. Interpolated piecewise-linearly.
 */
const AXIS_ANCHORS: ReadonlyArray<readonly [offset: number, score: number]> = [
  [-12, 100],
  [0, 85],
  [5, 65],
  [10, 52],
  [20, 40],
  [40, 18],
  [60, 5],
] as const;

/**
 * Piecewise-linear interpolation of an over-/under-target `offset`
 * (mmHg relative to the axis ceiling) onto the 0-100 axis score.
 * Clamps to the first / last anchor outside the table range.
 */
function interpolateAxisScore(offset: number): number {
  const first = AXIS_ANCHORS[0];
  const last = AXIS_ANCHORS[AXIS_ANCHORS.length - 1];
  if (offset <= first[0]) return first[1];
  if (offset >= last[0]) return last[1];
  for (let i = 0; i < AXIS_ANCHORS.length - 1; i++) {
    const [o1, s1] = AXIS_ANCHORS[i];
    const [o2, s2] = AXIS_ANCHORS[i + 1];
    if (offset >= o1 && offset <= o2) {
      const fraction = (offset - o1) / (o2 - o1);
      return s1 + fraction * (s2 - s1);
    }
  }
  return last[1];
}

/**
 * Score one BP axis against its ceiling.
 *
 * - Above the floor: offset = `value - ceiling`. Negative offsets sit in
 *   the optimal plateau, positive ones climb the over-target curve.
 * - Below the hypotension floor: the distance below the floor is fed
 *   through the same over-target curve so a low excursion is penalised
 *   symmetrically to an equally-distant high one.
 */
function gradeAxis(value: number, ceiling: number, floor: number): number {
  if (value < floor) {
    return interpolateAxisScore(floor - value);
  }
  return interpolateAxisScore(value - ceiling);
}

/**
 * Map a representative blood-pressure reading to a smooth 0-100 score.
 *
 * Takes the WORSE of the systolic and diastolic axis sub-scores so a
 * high diastolic counts against the score (it should) without
 * binary-zeroing the result the way the all-time in-target rate did.
 *
 * @returns integer 0-100.
 */
export function gradeBpScore(input: {
  sys: number;
  dia: number;
  target: BpTargets;
}): number {
  const sysScore = gradeAxis(
    input.sys,
    input.target.sysHigh,
    SYS_HYPOTENSION_FLOOR,
  );
  const diaScore = gradeAxis(
    input.dia,
    input.target.diaHigh,
    DIA_HYPOTENSION_FLOOR,
  );
  return Math.round(Math.max(0, Math.min(100, Math.min(sysScore, diaScore))));
}

/**
 * One timestamped BP pair for the recency-weighted representative.
 */
export interface BpPairPoint {
  /** Wall-clock of the reading (ms epoch ordering only — no tz math). */
  at: Date;
  sys: number;
  dia: number;
}

/**
 * Collapse a series of paired BP readings into a single recency-weighted
 * representative `{ sys, dia }`, then grade it.
 *
 * Recent readings should dominate so that genuine improvement surfaces in
 * the score rather than being diluted by years of older readings. Each
 * pair is weighted by an exponential decay on its age relative to `now`,
 * with a half-life of `HALF_LIFE_DAYS` (45 d): a reading 45 days old
 * counts half as much as today's, 90 days old a quarter, etc. The
 * weighted mean of sys and dia is the representative reading.
 *
 * Returns `null` when the series is empty (caller leaves the pillar
 * absent — the redistribution helper then drops the BP weight cleanly).
 */
const HALF_LIFE_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

export function gradeBpScoreFromSeries(input: {
  pairs: ReadonlyArray<BpPairPoint>;
  target: BpTargets;
  now: Date;
}): number | null {
  const { pairs, target, now } = input;
  if (pairs.length === 0) return null;

  const nowMs = now.getTime();
  let weightSum = 0;
  let sysWeighted = 0;
  let diaWeighted = 0;
  for (const p of pairs) {
    const ageDays = Math.max(0, (nowMs - p.at.getTime()) / DAY_MS);
    const weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    weightSum += weight;
    sysWeighted += weight * p.sys;
    diaWeighted += weight * p.dia;
  }
  if (weightSum === 0) return null;

  const sys = sysWeighted / weightSum;
  const dia = diaWeighted / weightSum;
  return gradeBpScore({ sys, dia, target });
}
