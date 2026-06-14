/**
 * Glucose clinical-metrics core — server-authoritative analytics layer.
 *
 * Pure, side-effect-free functions over an array of spot blood-glucose
 * readings (canonical **mg/dL**, the HealthLog store unit — see
 * `src/lib/glucose.ts` for unit conversion; this module never duplicates it).
 * One engine: the analytics route, the AI coach, the doctor-report PDF/FHIR
 * export, and the iOS client all read these numbers. iOS RENDERS the output,
 * it never recomputes — keeping the clinical math in one literature-locked
 * place.
 *
 * IMPORTANT honesty contract: HealthLog stores SPOT readings (FASTING /
 * POSTPRANDIAL / RANDOM / BEDTIME), NOT a dense CGM stream. The classic
 * CGM-adequacy bar (Battelino 2019: 14 days with ≥70% of possible readings)
 * cannot be met by spot data. Therefore every TIR / GMI / eA1C produced here
 * is a SPOT-READING ESTIMATE — a "% of readings" distribution, NOT a "% of
 * time" AGP report. The {@link GlucoseClinicalMetrics.stillLearning} gate and
 * the per-metric labelling exist so callers never assert a clinical AGP off
 * thin spot data.
 *
 * Thresholds and formulas are clean-room from the primary literature (the
 * consensus band values and coefficients are mathematical facts, not
 * copyrightable). Each function cites its source inline. Defer the
 * dense-stream indices (MAGE, CONGA, MODD, ADRR, AGP, time-weighted mean) to
 * the future CGM integration — they need ordered, closely-spaced samples this
 * module deliberately does not assume.
 *
 * Citations:
 *   Battelino 2019, Diabetes Care 42(8):1593-1603, DOI 10.2337/dci19-0028.
 *   Bergenstal 2018, Diabetes Care 41(11):2275-2280, DOI 10.2337/dc18-1581.
 *   Nathan 2008 (ADAG), Diabetes Care 31(8):1473-1478, DOI 10.2337/dc08-0545.
 *   Monnier 2017, Diabetes Care 40(7):832-838, DOI 10.2337/dc16-1769.
 */

// ── Inputs ───────────────────────────────────────────────

/** A single spot blood-glucose reading. Value is canonical mg/dL. */
export interface GlucoseReading {
  /** When the sample was taken. */
  measuredAt: Date;
  /** Glucose value in mg/dL (HealthLog canonical store unit). */
  mgdl: number;
}

/** Options for the clinical-window computation. */
export interface GlucoseMetricsOptions {
  /**
   * Clinical reporting window in days. Default 14 — the Battelino 2019
   * consensus reporting period. Readings older than `now - windowDays` are
   * excluded. Configurable so the doctor report or a longer trend view can
   * widen it.
   */
  windowDays?: number;
  /**
   * Anchor for the window. Defaults to `new Date()`. Injectable purely to keep
   * the module deterministic under test — there is no other side effect.
   */
  now?: Date;
  /**
   * Minimum number of in-window readings before TIR/GMI/eA1C/CV are asserted
   * rather than gated behind `stillLearning`. Default 14 — roughly one reading
   * per day across the window; below this a spot-data estimate is not
   * clinically meaningful.
   */
  minReadings?: number;
  /**
   * Minimum span (first→last reading, in days) the window's readings must
   * cover. Default 7. A burst of readings inside a single day cannot stand in
   * for two weeks of glycaemic behaviour.
   */
  minSpanDays?: number;
}

// ── Consensus thresholds (Battelino 2019) ────────────────
// Bands in mg/dL. These are consensus FACTS, cited above.
const TBR_LEVEL2_MAX = 54; // very low: G < 54
const TBR_LEVEL1_MAX = 70; // low: G < 70 (level-1 sub-band is 54–69)
const TAR_LEVEL1_MIN = 180; // high: G > 180 (level-1 sub-band is 181–250)
const TAR_LEVEL2_MIN = 250; // very high: G > 250
// Time-in-range target band is [70, 180] inclusive.

/** Monnier 2017 variability cutoff: CV% ≥ 36 is "unstable". */
export const CV_INSTABILITY_THRESHOLD = 36;

/** Battelino 2019 reporting defaults. */
export const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_MIN_READINGS = 14;
const DEFAULT_MIN_SPAN_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Output shapes ────────────────────────────────────────

/**
 * Battelino 2019 time-in-range distribution as fractions of readings (0–1).
 * `*Minutes` carry the minutes-equivalent over a 24h day (fraction × 1440) so
 * the UI can echo the consensus "<N min/day" goals; these are minutes-OF-A-DAY
 * equivalents of a per-reading distribution, NOT measured time-on-CGM.
 */
export interface TimeInRangeDistribution {
  /** % readings 70 ≤ G ≤ 180. Goal > 0.70. */
  tir: number;
  /** % readings G < 70 (includes the very-low sub-band). Goal < 0.04. */
  tbrLevel1: number;
  /** % readings G < 54. Goal < 0.01. */
  tbrLevel2: number;
  /** % readings G > 180 (includes the very-high sub-band). Goal < 0.25. */
  tarLevel1: number;
  /** % readings G > 250. Goal < 0.05. */
  tarLevel2: number;
  /** Minutes-of-a-day equivalents (fraction × 1440). */
  minutesEquivalent: {
    tir: number;
    tbrLevel1: number;
    tbrLevel2: number;
    tarLevel1: number;
    tarLevel2: number;
  };
}

/** Variability summary: SD + CV% with the Monnier stability flag. */
export interface GlucoseVariability {
  /** Sample standard deviation (n−1), mg/dL. */
  sd: number;
  /** Coefficient of variation, percent: SD / mean × 100. */
  cv: number;
  /** True when CV% ≥ 36 (Monnier 2017 instability cutoff). */
  unstable: boolean;
}

/** The full clinical-metrics result for a window of spot readings. */
export interface GlucoseClinicalMetrics {
  /**
   * When true, the window has too few readings or too short a span to assert a
   * clinically meaningful estimate. The numeric fields below are still
   * populated from whatever data exists (so a calm preview can render) but MUST
   * NOT be presented as a clinical assessment. The UI should render a
   * "still learning — N readings over D days" state.
   */
  stillLearning: boolean;
  /** Human/UI-facing reason for the gate (null once it clears). */
  stillLearningReason: string | null;

  /** Declared clinical window in days (the requested `windowDays`). */
  windowDays: number;
  /** Actual span the in-window readings cover (first→last), in days. */
  actualSpanDays: number;
  /** Number of readings used (those falling inside the window). */
  readingCount: number;

  /** Arithmetic mean glucose over the window, mg/dL (null if no readings). */
  meanMgdl: number | null;

  /** Battelino 2019 TIR/TBR/TAR distribution (null if no readings). */
  distribution: TimeInRangeDistribution | null;
  /** Bergenstal 2018 Glucose Management Indicator, percent (null if no data). */
  gmi: number | null;
  /** Nathan 2008 estimated A1C, percent (null if no data). */
  estimatedA1c: number | null;
  /** SD + CV% + instability flag (null if < 2 readings). */
  variability: GlucoseVariability | null;

  /**
   * Always true for this module: every number is a spot-reading estimate, not a
   * CGM AGP. Surfaced explicitly so serializers (panel/coach/PDF/iOS) carry the
   * caveat without re-deriving it.
   */
  isSpotEstimate: true;
}

// ── Core formulas ────────────────────────────────────────

/** Arithmetic mean. Caller guarantees a non-empty array. */
function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Sample standard deviation, sqrt(Σ(Gᵢ−mean)² / (n−1)).
 * Standard variability foundation reported alongside mean in Battelino 2019.
 * Returns null for n < 2 (undefined sample SD).
 */
export function glucoseSD(values: number[]): number | null {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values);
  let ss = 0;
  for (const v of values) {
    const d = v - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

/**
 * Coefficient of variation (%) with the Monnier 2017 instability flag.
 * %CV = SD / mean × 100; CV% ≥ 36 → unstable.
 * Monnier 2017, Diabetes Care 40(7):832-838, DOI 10.2337/dc16-1769;
 * endorsed in Battelino 2019.
 */
export function glucoseVariability(values: number[]): GlucoseVariability | null {
  const sd = glucoseSD(values);
  if (sd === null) return null;
  const m = mean(values);
  if (m === 0) return null;
  const cv = (sd / m) * 100;
  return { sd, cv, unstable: cv >= CV_INSTABILITY_THRESHOLD };
}

/**
 * Glucose Management Indicator (GMI), percent, from mean glucose in mg/dL.
 * GMI% = 3.31 + 0.02392 × mean(mg/dL).
 * Bergenstal 2018, Diabetes Care 41(11):2275-2280, DOI 10.2337/dc18-1581.
 */
export function gmi(meanMgdl: number): number {
  return 3.31 + 0.02392 * meanMgdl;
}

/**
 * Estimated A1C (%) from mean glucose in mg/dL (ADAG inverse of eAG).
 * eAG = 28.7 × A1C − 46.7  ⇒  A1C% = (mean + 46.7) / 28.7.
 * Nathan 2008 (ADAG), Diabetes Care 31(8):1473-1478, DOI 10.2337/dc08-0545.
 * Preferred for spot/SMBG data; GMI is the CGM-native sibling.
 */
export function estimatedA1c(meanMgdl: number): number {
  return (meanMgdl + 46.7) / 28.7;
}

/**
 * Time-in-range distribution over the Battelino 2019 consensus bands, as
 * fractions of readings (NOT % of time — spot data, labelled honestly).
 *   TIR  : 70 ≤ G ≤ 180     (goal > 0.70)
 *   TBR1 : G < 70           (goal < 0.04)
 *   TBR2 : G < 54           (goal < 0.01)
 *   TAR1 : G > 180          (goal < 0.25)
 *   TAR2 : G > 250          (goal < 0.05)
 * TBR2 ⊆ TBR1 and TAR2 ⊆ TAR1 (the consensus reports level-2 as a sub-band of
 * level-1), so the five fractions are NOT mutually exclusive by design.
 * Battelino 2019, Diabetes Care 42(8):1593-1603, DOI 10.2337/dci19-0028.
 */
export function timeInRange(
  values: number[],
): TimeInRangeDistribution | null {
  const n = values.length;
  if (n === 0) return null;

  let inRange = 0;
  let below70 = 0;
  let below54 = 0;
  let above180 = 0;
  let above250 = 0;

  for (const g of values) {
    if (g < TBR_LEVEL1_MAX) {
      below70 += 1;
      if (g < TBR_LEVEL2_MAX) below54 += 1;
    } else if (g > TAR_LEVEL1_MIN) {
      above180 += 1;
      if (g > TAR_LEVEL2_MIN) above250 += 1;
    } else {
      // 70 ≤ G ≤ 180
      inRange += 1;
    }
  }

  const tir = inRange / n;
  const tbrLevel1 = below70 / n;
  const tbrLevel2 = below54 / n;
  const tarLevel1 = above180 / n;
  const tarLevel2 = above250 / n;
  const MIN_PER_DAY = 1440;

  return {
    tir,
    tbrLevel1,
    tbrLevel2,
    tarLevel1,
    tarLevel2,
    minutesEquivalent: {
      tir: tir * MIN_PER_DAY,
      tbrLevel1: tbrLevel1 * MIN_PER_DAY,
      tbrLevel2: tbrLevel2 * MIN_PER_DAY,
      tarLevel1: tarLevel1 * MIN_PER_DAY,
      tarLevel2: tarLevel2 * MIN_PER_DAY,
    },
  };
}

// ── Window + adequacy orchestration ──────────────────────

/**
 * Compute the full clinical-metrics panel for a set of spot readings.
 *
 * Pins a declared clinical window (default 14d, Battelino 2019), reports the
 * actual span + reading count used, and applies the learning/adequacy gate so
 * the caller never presents a thin-data estimate as a clinical assessment.
 *
 * Pure: no Prisma, no I/O. `now` is injectable for deterministic tests.
 */
export function computeGlucoseClinicalMetrics(
  readings: GlucoseReading[],
  options: GlucoseMetricsOptions = {},
): GlucoseClinicalMetrics {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const minReadings = options.minReadings ?? DEFAULT_MIN_READINGS;
  const minSpanDays = options.minSpanDays ?? DEFAULT_MIN_SPAN_DAYS;

  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const inWindow = readings
    .filter(
      (r) =>
        r.measuredAt.getTime() >= cutoff &&
        r.measuredAt.getTime() <= now.getTime() &&
        Number.isFinite(r.mgdl),
    )
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());

  const readingCount = inWindow.length;
  const actualSpanDays =
    readingCount >= 2
      ? (inWindow[readingCount - 1].measuredAt.getTime() -
          inWindow[0].measuredAt.getTime()) /
        MS_PER_DAY
      : 0;

  const values = inWindow.map((r) => r.mgdl);
  const meanMgdl = values.length > 0 ? mean(values) : null;

  const distribution = timeInRange(values);
  const variability = glucoseVariability(values);
  const gmiValue = meanMgdl !== null ? gmi(meanMgdl) : null;
  const eA1cValue = meanMgdl !== null ? estimatedA1c(meanMgdl) : null;

  // Learning/adequacy gate. Spot data cannot meet the CGM adequacy bar; this
  // is the honest "is the estimate worth asserting yet" check. Order matters:
  // report the most actionable reason first.
  let stillLearning = false;
  let stillLearningReason: string | null = null;

  if (readingCount === 0) {
    stillLearning = true;
    stillLearningReason = `No glucose readings in the last ${windowDays} days.`;
  } else if (readingCount < minReadings) {
    stillLearning = true;
    stillLearningReason = `Still learning — ${readingCount} reading${
      readingCount === 1 ? "" : "s"
    } over ${roundSpan(actualSpanDays)} day${
      roundSpan(actualSpanDays) === 1 ? "" : "s"
    }; at least ${minReadings} are needed for a meaningful estimate.`;
  } else if (actualSpanDays < minSpanDays) {
    stillLearning = true;
    stillLearningReason = `Still learning — readings span only ${roundSpan(
      actualSpanDays,
    )} day${
      roundSpan(actualSpanDays) === 1 ? "" : "s"
    }; at least ${minSpanDays} days of coverage are needed.`;
  }

  return {
    stillLearning,
    stillLearningReason,
    windowDays,
    actualSpanDays,
    readingCount,
    meanMgdl,
    distribution,
    gmi: gmiValue,
    estimatedA1c: eA1cValue,
    variability,
    isSpotEstimate: true,
  };
}

/** Round a span to whole days for the human-facing learning message. */
function roundSpan(spanDays: number): number {
  return Math.max(0, Math.round(spanDays));
}
