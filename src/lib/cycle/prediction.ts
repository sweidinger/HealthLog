/**
 * Cycle prediction engine — pure, deterministic, DB-free.
 *
 * Implements algorithm.md §1–§5 exactly. The iOS team re-implements this 1:1 in
 * Swift from the same spec, so every constant, every rounding step, and every
 * day-diff MUST match. See `day-math.ts` for the shared arithmetic and
 * `types.ts` for the pinned constants.
 *
 * The symptothermal layer re-implements the published sensiplan rules
 * (3-over-6 temperature double-check + cervical-mucus peak). It does NOT copy
 * drip's GPL-3.0 code; the rule LOGIC is the gold-standard FAM method and is not
 * itself copyrightable. drip is cited as prior art only.
 */

import { addDays, dayDiff, roundHalf } from "./day-math";
import {
  ADHERENCE_FLOOR,
  ADHERENCE_SLOPE,
  BBT_WINDOW,
  COLD_START_BAND_BONUS,
  CONFIDENCE_LABEL_HIGH_MIN,
  CONFIDENCE_LABEL_LOW_MAX,
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  FERTILE_POST,
  FERTILE_PRE,
  HALF_WIDTH_MAX,
  HALF_WIDTH_MIN,
  HALF_WIDTH_MULT_SYMPTOTHERMAL,
  HALF_WIDTH_MULT_TEMP_TREND,
  HARD_CYCLE_MAX,
  HARD_CYCLE_MIN,
  HISTORY_WINDOW_N,
  LOG_SPARSITY_SCALE,
  LUTEAL_DEFAULT,
  LUTEAL_MAX,
  LUTEAL_MIN,
  MAD_NORMAL_CONST,
  MISSED_LOG_FACTOR,
  OUTLIER_K,
  OUTLIER_K_PERIMENOPAUSE,
  PERIOD_MAX,
  PERIOD_MIN,
  PERIOD_WINDOW_N,
  POPULATION_DEFAULT_CYCLE,
  POPULATION_DEFAULT_PERIOD,
  PRIORS_ONLY_HALF_WIDTH,
  SIGMA_FLOOR,
  SYMPTOTHERMAL_AGREE_DAYS,
  TEMP_SHIFT_C_MANUAL,
  TEMP_SHIFT_C_PASSIVE,
  Z_BAND,
  type ConfidenceLabel,
  type CycleInput,
  type CyclePredictionResult,
  type CycleProfileInput,
  type DayLogInput,
  type NightlyTempInput,
  type PredictionMethod,
} from "./types";

/* ------------------------------------------------------------------ */
/* Robust statistics primitives                                       */
/* ------------------------------------------------------------------ */

/**
 * Median of a numeric array. For an even count, the mean of the two central
 * order statistics (NOT rounded — fractional precision is kept through the CI
 * math per §1 step 3). Empty input returns NaN; callers guard against that.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation about a given centre. */
export function mad(values: readonly number[], centre: number): number {
  if (values.length === 0) return NaN;
  return median(values.map((v) => Math.abs(v - centre)));
}

/* ------------------------------------------------------------------ */
/* §1 — cycle-length estimation                                       */
/* ------------------------------------------------------------------ */

/** Completed cycle = one whose successor's start exists, giving a known length. */
function completedLengths(cycles: readonly CycleInput[]): number[] {
  // Sort by startDate ascending (the canonical order), then diff consecutive
  // starts. A cycle is completed iff a later start exists.
  const starts = cycles.map((c) => c.startDate).sort((a, b) => dayDiff(a, b));
  const lengths: number[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    lengths.push(dayDiff(starts[i + 1], starts[i]));
  }
  return lengths;
}

interface LengthEstimate {
  /** Robust central length, fractional (rounded only at point-estimate use). */
  lengthFractional: number;
  /** Rounded typical length (days). */
  lengthRounded: number;
  /** Robust SD (days), >= SIGMA_FLOOR. */
  sigma: number;
  /** Coefficient of robust variation sigma/length. */
  cv: number;
  /** Count of lengths used post outlier-exclusion. */
  cyclesObserved: number;
}

/**
 * §1 + §5 — robust median+MAD over the trailing window with 3-MAD outlier
 * exclusion and missed-log detection. Returns the central length, robust SD,
 * cv, and post-exclusion count.
 */
export function estimateCycleLength(
  lengths: readonly number[],
  goal: CycleProfileInput["goal"],
): LengthEstimate {
  // Trailing window: most recent N completed lengths.
  const Ls = lengths.slice(-HISTORY_WINDOW_N);

  if (Ls.length === 0) {
    return {
      lengthFractional: NaN,
      lengthRounded: NaN,
      sigma: SIGMA_FLOOR,
      cv: 0,
      cyclesObserved: 0,
    };
  }

  // Pre-exclusion robust dispersion for the fence (§5).
  const preMedian = median(Ls);
  const sigmaPre = MAD_NORMAL_CONST * mad(Ls, preMedian);

  const k = goal === "PERIMENOPAUSE" ? OUTLIER_K_PERIMENOPAUSE : OUTLIER_K;
  const fenceLow = preMedian - k * sigmaPre;
  const fenceHigh = preMedian + k * sigmaPre;
  const missedLogThreshold = MISSED_LOG_FACTOR * preMedian;

  // Outlier exclusion: robust MAD fence OR hard physiological bounds OR a
  // probable missed-log (a single length >= 1.75 * median).
  const kept = Ls.filter((L) => {
    const beyondFence = sigmaPre > 0 && (L < fenceLow || L > fenceHigh);
    const beyondHard = L < HARD_CYCLE_MIN || L > HARD_CYCLE_MAX;
    const missedLog = L >= missedLogThreshold;
    return !(beyondFence || beyondHard || missedLog);
  });

  // If exclusion empties the array, fall back to the un-excluded median (§1.2),
  // but the cyclesObserved still reflects the excluded count (§5: outliers don't
  // bias the point estimate but they DO erode confidence).
  const usable = kept.length >= 1 ? kept : Ls;

  const lengthFractional = median(usable);
  const lengthRounded = roundHalf(lengthFractional);
  const sigmaRaw = MAD_NORMAL_CONST * mad(usable, lengthFractional);
  const sigma = sigmaRaw > 0 ? sigmaRaw : SIGMA_FLOOR;
  const cv = lengthFractional > 0 ? sigma / lengthFractional : 0;

  return {
    lengthFractional,
    lengthRounded,
    sigma,
    cv,
    // cyclesObserved counts the kept (non-excluded) lengths — excluded cycles
    // are not counted toward the cycle-count confidence factor (§5).
    cyclesObserved: kept.length,
  };
}

/* ------------------------------------------------------------------ */
/* §2 — period-length estimation                                      */
/* ------------------------------------------------------------------ */

/** Bleeding day = flow in {SPOTTING, LIGHT, MEDIUM, HEAVY}. */
function isBleeding(flow: DayLogInput["flow"]): boolean {
  return (
    flow === "SPOTTING" ||
    flow === "LIGHT" ||
    flow === "MEDIUM" ||
    flow === "HEAVY"
  );
}

/**
 * §2 — observed period length for one cycle: the maximal CONTIGUOUS run of
 * bleeding days starting at `startDate`. A single isolated dry day inside the
 * run does NOT break it; a gap of >= 2 consecutive non-bleeding days does.
 */
export function observedPeriodLength(
  startDate: string,
  dayLogs: readonly DayLogInput[],
): number {
  const bleedingByDate = new Map<string, boolean>();
  for (const log of dayLogs) {
    if (isBleeding(log.flow)) bleedingByDate.set(log.date, true);
  }
  if (!bleedingByDate.get(startDate)) return 0;

  let lastBleeding = 0; // offset (days) of the last confirmed bleeding day
  let gap = 0; // consecutive non-bleeding days seen since last bleeding
  // Walk forward up to PERIOD_MAX + 1 days; the run breaks on a >=2-day gap.
  for (let offset = 0; offset <= PERIOD_MAX + 1; offset++) {
    const date = addDays(startDate, offset);
    if (bleedingByDate.get(date)) {
      lastBleeding = offset;
      gap = 0;
    } else {
      gap++;
      if (gap >= 2) break; // two consecutive dry days ends the run
    }
  }
  return lastBleeding + 1; // inclusive count of days from start to last bleeding
}

/** §2 — robust period-length estimate over the last 6 cycles, clamped [1,10]. */
export function estimatePeriodLength(
  cycles: readonly CycleInput[],
  dayLogs: readonly DayLogInput[],
  profile: CycleProfileInput,
): number {
  const sorted = [...cycles].sort((a, b) => dayDiff(a.startDate, b.startDate));
  const recent = sorted.slice(-PERIOD_WINDOW_N);
  const observed: number[] = [];
  for (const c of recent) {
    // Prefer an explicit periodEndDate if present; else derive from day logs.
    if (c.periodEndDate) {
      const len = dayDiff(c.periodEndDate, c.startDate) + 1;
      if (len >= PERIOD_MIN) observed.push(len);
    } else {
      const len = observedPeriodLength(c.startDate, dayLogs);
      if (len >= PERIOD_MIN) observed.push(len);
    }
  }

  if (observed.length === 0) {
    const prior = profile.typicalPeriodLength ?? POPULATION_DEFAULT_PERIOD;
    return clamp(roundHalf(prior), PERIOD_MIN, PERIOD_MAX);
  }
  return clamp(roundHalf(median(observed)), PERIOD_MIN, PERIOD_MAX);
}

/* ------------------------------------------------------------------ */
/* §4 — symptothermal + temperature-trend ovulation detection         */
/* ------------------------------------------------------------------ */

interface TempShiftResult {
  /** Confirmed ovulation day = day before the first of the 3 elevated readings. */
  ovulationDate: string;
}

/**
 * §4.2(a) — sensiplan 3-over-6 BBT rule on manual basal temperatures.
 * The first day of 3 consecutive temps each strictly above the highest of the
 * immediately preceding 6 temps, AND the 3rd is >= 0.2°C above that 6-day max.
 * Ovulation = the last low-temp day before the rise (the day BEFORE the first
 * elevated reading).
 */
export function detectTempShift(
  dayLogs: readonly DayLogInput[],
  thresholdC: number,
): TempShiftResult | null {
  const temps = dayLogs
    .filter((l) => l.basalBodyTempC != null)
    .map((l) => ({ date: l.date, t: l.basalBodyTempC as number }))
    .sort((a, b) => dayDiff(a.date, b.date));

  // Need 6 baseline + 3 elevated = 9 readings minimum. Scan from the END and
  // return the LATEST qualifying shift — for a multi-cycle BBT series the most
  // recent rise is the one that belongs to the current cycle; the earliest
  // match would confirm a months-old ovulation (QA: window scoping).
  for (let i = temps.length - 3; i >= 6; i--) {
    const baseline = temps.slice(i - 6, i);
    const sixMax = Math.max(...baseline.map((x) => x.t));
    const rise = [temps[i], temps[i + 1], temps[i + 2]];
    const allAbove = rise.every((r) => r.t > sixMax);
    // The 3rd elevated reading must clear the 6-day max by the threshold.
    const thirdClears = roundHalf(rise[2].t - sixMax, 2) >= thresholdC;
    if (allAbove && thirdClears) {
      // Ovulation = day before the first elevated reading.
      return { ovulationDate: addDays(rise[0].date, -1) };
    }
  }
  return null;
}

/**
 * §4.2(b) — cervical-mucus peak: the LAST day of egg-white/watery mucus.
 * Infertile phase confirmed on peak+3; ovulation is taken at the peak day for
 * the agreement check.
 */
export function detectMucusPeak(
  dayLogs: readonly DayLogInput[],
): string | null {
  const peakDays = dayLogs
    .filter(
      (l) => l.cervicalMucus === "EGG_WHITE" || l.cervicalMucus === "WATERY",
    )
    .map((l) => l.date)
    .sort((a, b) => dayDiff(a, b));
  return peakDays.length > 0 ? peakDays[peakDays.length - 1] : null;
}

/**
 * §4.2 — symptothermal CONFIRMATION: ovulation is confirmed only when the
 * temp-shift day and the mucus-peak agree within ±2 days. Returns the
 * temp-derived ovulation day when confirmed, else null.
 */
export function confirmSymptothermal(
  dayLogs: readonly DayLogInput[],
): string | null {
  const shift = detectTempShift(dayLogs, TEMP_SHIFT_C_MANUAL);
  if (!shift) return null;
  const peak = detectMucusPeak(dayLogs);
  if (!peak) return null;
  if (
    Math.abs(dayDiff(shift.ovulationDate, peak)) <= SYMPTOTHERMAL_AGREE_DAYS
  ) {
    return shift.ovulationDate;
  }
  return null;
}

/**
 * §4.3 — passive TEMPERATURE_TREND: detect the post-ovulatory sustained thermal
 * shift on a nightly series — 3-of-4 consecutive nights with deviation
 * >= +0.15°C above the trailing 6-night mean. Ovulation ≈ the night before the
 * sustained rise onset. Returns the ovulation day or null.
 */
export function detectTemperatureTrend(
  nights: readonly NightlyTempInput[],
): string | null {
  const series = [...nights].sort((a, b) => dayDiff(a.date, b.date));
  // Need 6 trailing nights + a 4-night window.
  for (let i = 6; i + 3 < series.length; i++) {
    const trailing = series.slice(i - 6, i);
    const mean = trailing.reduce((s, x) => s + x.valueC, 0) / trailing.length;
    const window = series.slice(i, i + 4);
    const elevated = window.filter(
      (n) => roundHalf(n.valueC - mean, 2) >= TEMP_SHIFT_C_PASSIVE,
    ).length;
    if (elevated >= 3) {
      // Ovulation ≈ night before the sustained rise onset (the first window day).
      return addDays(window[0].date, -1);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* §3 — confidence + band                                             */
/* ------------------------------------------------------------------ */

/** §3(b) — cycle-count factor. */
function countFactor(cyclesObserved: number): number {
  if (cyclesObserved <= 0) return 0.2;
  if (cyclesObserved === 1) return 0.35;
  if (cyclesObserved === 2) return 0.55;
  if (cyclesObserved <= 5) return 0.75;
  return 1.0;
}

/** §3(b) — regularity factor from the coefficient of robust variation. */
function varianceFactor(cv: number): number {
  if (cv <= 0.05) return 1.0;
  if (cv <= 0.09) return 0.85;
  if (cv <= 0.14) return 0.65;
  if (cv <= 0.2) return 0.45;
  return 0.25;
}

/**
 * §3(b)/§3 — logging-density derived factors. Returns the adherence confidence
 * factor and the LOG_SPARSITY band-penalty term.
 */
function adherenceFactors(
  lastStart: string,
  estimatedLength: number,
  dayLogs: readonly DayLogInput[],
  today: string,
): { cAdherence: number; logSparsity: number } {
  // expectedDays = days since the most recent cycle start, capped at length.
  const sinceStart = Math.max(0, dayDiff(today, lastStart));
  const expectedDays = Math.min(
    sinceStart,
    Math.max(1, Math.round(estimatedLength)),
  );
  // loggedDays = day logs with any non-null observation in that span.
  let loggedDays = 0;
  for (const log of dayLogs) {
    const offset = dayDiff(log.date, lastStart);
    if (offset < 0 || offset > expectedDays) continue;
    const hasObservation =
      log.flow != null ||
      log.basalBodyTempC != null ||
      log.ovulationTest != null ||
      log.cervicalMucus != null;
    if (hasObservation) loggedDays++;
  }
  const density = clamp(loggedDays / Math.max(1, expectedDays), 0, 1);
  const cAdherence = ADHERENCE_FLOOR + ADHERENCE_SLOPE * density;
  const logSparsity = (1 - density) * LOG_SPARSITY_SCALE;
  return { cAdherence, logSparsity };
}

/** §3 — confidence → label mapping. */
function confidenceLabel(confidence: number): ConfidenceLabel {
  if (confidence < CONFIDENCE_LABEL_LOW_MAX) return "low";
  if (confidence > CONFIDENCE_LABEL_HIGH_MIN) return "high";
  return "medium";
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Clamp a raw luteal length to the physiological range [LUTEAL_MIN, LUTEAL_MAX]
 * (§4). The ONE source of truth for resolving luteal length — the engine,
 * calendar adapter, and phase mapper all route through this so the
 * predicted-ovulation dot and the OVULATORY band can never diverge for a user
 * whose stored value is out of clamp (QA HIGH: luteal clamp divergence).
 */
export function clampLuteal(raw: number): number {
  return clamp(raw, LUTEAL_MIN, LUTEAL_MAX);
}

export function resolveLuteal(
  profile: Pick<CycleProfileInput, "lutealPhaseLength">,
): number {
  return clampLuteal(profile.lutealPhaseLength ?? LUTEAL_DEFAULT);
}

/* ------------------------------------------------------------------ */
/* main entry                                                         */
/* ------------------------------------------------------------------ */

/**
 * §1–§5 — compute the cycle prediction.
 *
 * The fertile window is ALWAYS returned (goal-gating — suppressing it for
 * non-conception goals — is the caller's responsibility per the spec; the
 * engine returns the window and the caller hides it).
 *
 * @param cycles    confirmed (non-predicted) cycles; order-independent.
 * @param dayLogs   all day logs the device holds (for period, symptothermal).
 * @param profile   user priors + mode flags.
 * @param today     `YYYY-MM-DD` reference day (for adherence density).
 * @param nights    optional nightly passive-temperature series (Apple Watch).
 */
export function predictCycle(
  cycles: readonly CycleInput[],
  dayLogs: readonly DayLogInput[],
  profile: CycleProfileInput,
  today: string,
  nights: readonly NightlyTempInput[] = [],
): CyclePredictionResult {
  const lengths = completedLengths(cycles);
  const lutealLength = resolveLuteal(profile);
  const sortedStarts = cycles
    .map((c) => c.startDate)
    .sort((a, b) => dayDiff(a, b));
  const lastConfirmedStart = sortedStarts[sortedStarts.length - 1] ?? today;

  // -------- 0-cycle priors-only cold start (§5) --------
  if (lengths.length === 0) {
    const estLen = profile.typicalCycleLength ?? POPULATION_DEFAULT_CYCLE;
    const periodLen = clamp(
      roundHalf(profile.typicalPeriodLength ?? POPULATION_DEFAULT_PERIOD),
      PERIOD_MIN,
      PERIOD_MAX,
    );
    const nextStart = addDays(lastConfirmedStart, Math.round(estLen));
    const predictedOvulation = addDays(nextStart, -lutealLength);
    return finalize({
      method: "CALENDAR",
      nextStart,
      halfWidth: PRIORS_ONLY_HALF_WIDTH,
      predictedPeriodLength: periodLen,
      predictedOvulation,
      ovulationConfirmed: false,
      confidence: 0.2,
      cyclesObserved: 0,
      estimatedCycleLength: Math.round(estLen),
      estimatedCycleSd: SIGMA_FLOOR,
      lutealLength,
      goal: profile.goal,
    });
  }

  // -------- robust estimation (§1, §2) --------
  const est = estimateCycleLength(lengths, profile.goal);
  const periodLen = estimatePeriodLength(cycles, dayLogs, profile);

  // -------- calendar baseline next-period point estimate (§1) --------
  let method: PredictionMethod = "CALENDAR";
  let nextStart = addDays(lastConfirmedStart, est.lengthRounded);
  let predictedOvulation = addDays(nextStart, -lutealLength);
  let ovulationConfirmed = false;
  let confirmMultiplier = 1.0;

  // -------- §4 method ladder + blend (confirmed-current overrides) --------
  // Precedence: confirmed-symptothermal > temperature-trend > calendar. A
  // confirmed signal overrides the CURRENT cycle's ovulation/next-start; the
  // calendar predictor still fills all FUTURE cycles (BLENDED records that mix).
  //
  // Window scoping (QA HIGH): the symptothermal/temperature-trend detectors
  // must only see the CURRENT cycle's signal, otherwise a multi-cycle user's
  // stale prior-cycle BBT/mucus confirms a months-old ovulation and lands
  // nextPeriodStart in the past. Scope to [lastConfirmedStart − BBT_WINDOW,
  // today]; the BBT_WINDOW reach-back keeps the 6-reading baseline intact for a
  // young current cycle. detectTempShift returns the LATEST qualifying shift.
  const windowStart = addDays(lastConfirmedStart, -BBT_WINDOW);
  const isInCurrentWindow = (date: string) =>
    dayDiff(date, windowStart) >= 0 && dayDiff(today, date) >= 0;
  const currentDayLogs = dayLogs.filter((l) => isInCurrentWindow(l.date));
  const currentNights = nights.filter((n) => isInCurrentWindow(n.date));
  const symptoOvulation = confirmSymptothermal(currentDayLogs);
  const trendOvulation = symptoOvulation
    ? null
    : detectTemperatureTrend(currentNights);

  if (symptoOvulation) {
    const confirmedNextStart = addDays(symptoOvulation, lutealLength);
    // Reject a confirmation whose next-start is already in the past (a stale
    // signal that slipped through the window) — fall back to the calendar.
    if (dayDiff(confirmedNextStart, today) >= 0) {
      predictedOvulation = symptoOvulation;
      nextStart = confirmedNextStart;
      ovulationConfirmed = true;
      confirmMultiplier = HALF_WIDTH_MULT_SYMPTOTHERMAL;
      method = lengths.length > 0 ? "BLENDED" : "SYMPTOTHERMAL";
    }
  } else if (trendOvulation) {
    const confirmedNextStart = addDays(trendOvulation, lutealLength);
    if (dayDiff(confirmedNextStart, today) >= 0) {
      predictedOvulation = trendOvulation;
      nextStart = confirmedNextStart;
      ovulationConfirmed = true;
      confirmMultiplier = HALF_WIDTH_MULT_TEMP_TREND;
      method = lengths.length > 0 ? "BLENDED" : "TEMPERATURE_TREND";
    }
  }

  // -------- §3 band half-width --------
  const { cAdherence, logSparsity } = adherenceFactors(
    lastConfirmedStart,
    est.lengthFractional,
    dayLogs,
    today,
  );
  const adherencePenalty = 1 + logSparsity;
  let halfWidth =
    roundHalf(Z_BAND * est.sigma * adherencePenalty) * confirmMultiplier;
  // Single-cycle cold-start gets a fixed band bonus (§5).
  if (est.cyclesObserved === 1) halfWidth += COLD_START_BAND_BONUS;
  halfWidth = clamp(Math.round(halfWidth), HALF_WIDTH_MIN, HALF_WIDTH_MAX);

  // -------- §3 confidence scalar --------
  const cCount = countFactor(est.cyclesObserved);
  const cVariance = varianceFactor(est.cv);
  const confidence = clamp(
    cCount * cVariance * cAdherence,
    CONFIDENCE_MIN,
    CONFIDENCE_MAX,
  );

  return finalize({
    method,
    nextStart,
    halfWidth,
    predictedPeriodLength: periodLen,
    predictedOvulation,
    ovulationConfirmed,
    confidence,
    cyclesObserved: est.cyclesObserved,
    estimatedCycleLength: est.lengthRounded,
    estimatedCycleSd: roundHalf(est.sigma, 2),
    lutealLength,
    goal: profile.goal,
  });
}

interface FinalizeArgs {
  method: PredictionMethod;
  nextStart: string;
  halfWidth: number;
  predictedPeriodLength: number;
  predictedOvulation: string;
  ovulationConfirmed: boolean;
  confidence: number;
  cyclesObserved: number;
  estimatedCycleLength: number;
  estimatedCycleSd: number;
  lutealLength: number;
  goal: CycleProfileInput["goal"];
}

/** Assemble the result struct, deriving the band + fertile window. */
function finalize(a: FinalizeArgs): CyclePredictionResult {
  const halfWidth = clamp(
    Math.round(a.halfWidth),
    HALF_WIDTH_MIN,
    HALF_WIDTH_MAX,
  );
  const confidence = roundHalf(a.confidence, 2);
  return {
    method: a.method,
    nextPeriodStart: a.nextStart,
    nextPeriodStartLow: addDays(a.nextStart, -halfWidth),
    nextPeriodStartHigh: addDays(a.nextStart, halfWidth),
    predictedPeriodLength: a.predictedPeriodLength,
    fertileWindowStart: addDays(a.predictedOvulation, -FERTILE_PRE),
    fertileWindowEnd: addDays(a.predictedOvulation, FERTILE_POST),
    predictedOvulation: a.predictedOvulation,
    ovulationConfirmed: a.ovulationConfirmed,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    cyclesObserved: a.cyclesObserved,
    stillLearning: a.cyclesObserved < 3,
    estimatedCycleLength: a.estimatedCycleLength,
    estimatedCycleSd: a.estimatedCycleSd,
  };
}
