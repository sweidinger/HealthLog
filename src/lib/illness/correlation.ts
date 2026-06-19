/**
 * Illness correlation + recovery-gap engine (v1.18.1, Workstream B / P3).
 *
 * Server-authoritative, reliability-first. Given ONE illness episode this
 * assembles three retrospective findings — never a prediction, never a
 * diagnosis — each gated by the shared coverage/confidence model so a thin
 * signal asserts NOTHING:
 *
 *   1. **Pre-onset anomaly scan** — the N days BEFORE onset, each tracked
 *      vital's deviation in robust SDs from the user's OWN baseline (median
 *      ± MAD, the same `computeVitalsBaseline` engine), the baseline computed
 *      from a window that ENDS before the pre-onset lookback so the episode's
 *      own physiology can never poison the baseline it is measured against.
 *      "How did it announce itself?"
 *   2. **Nadir / what-dropped** — across the episode's active span, the
 *      furthest each vital strayed from baseline (the nadir day + magnitude +
 *      direction). "What dropped."
 *   3. **Recovery-gap** — the intellectual core: physiological return-to-
 *      baseline (first day a previously-deviated vital re-enters its band and
 *      STAYS in for `RETURN_STABILITY_DAYS`) vs the felt-better marker
 *      (`resolvedAt`). The gap is `physiologicalReturn − feltBetter` in days:
 *      positive = the body lagged the feeling (you felt better before your
 *      numbers did), negative = numbers normalised first. CHRONIC_ONGOING is
 *      excluded (no recovered date).
 *
 * The directionality of "worse" is metric-specific (a HRV/recovery DROP and a
 * resting-HR/temperature RISE both mean "stressed"); `ADVERSE_DIRECTION`
 * pins it per metric. Red-flag patterns (a sustained large oxygen-saturation
 * drop, a sustained fever) ESCALATE to a "seek care" flag — never reassure.
 *
 * Pure given its inputs: the caller does the bounded reads (baseline series +
 * per-day vital means within the episode window) and passes them in, so the
 * whole engine is unit-testable against golden fixtures with no DB. The route
 * wires the reads; the parity test asserts the rollup-fed path and a raw-SQL
 * path agree.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { buildBaselineBand, median } from "@/lib/insights/derived/baseline";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";

/* ── tunables (documented invariants) ────────────────────────────────── */

/** Days before onset scanned for the "how did it announce itself" signal. */
export const PRE_ONSET_LOOKBACK_DAYS = 7;
/** Trailing baseline window (days), ending BEFORE the pre-onset lookback. */
export const BASELINE_WINDOW_DAYS = 30;
/**
 * Minimum distinct baseline days a vital needs before we trust its band.
 * Mirrors `computeVitalsBaseline`'s 7-day floor — below this the vital is
 * dropped from the scan rather than asserted on a fragile band.
 */
export const MIN_BASELINE_DAYS = 7;
/**
 * A deviation of ≥ this many robust SDs (k·MAD·scale units) from baseline
 * counts as "notable" for the pre-onset + nadir surfaces. ~2σ-equivalent.
 */
export const NOTABLE_SD = 2;
/**
 * Consecutive in-band days required to call a vital "returned to baseline"
 * for the recovery-gap (one lucky in-band day is not a recovery).
 */
export const RETURN_STABILITY_DAYS = 3;
/** Minimum episode days with ANY vital coverage before the gap is asserted. */
export const MIN_EPISODE_COVERAGE_DAYS = 4;

/**
 * Per-metric adverse direction — which way a reading moves when the body is
 * under illness stress. `up` = a RISE is adverse (resting HR, temperature,
 * respiratory rate, BP); `down` = a DROP is adverse (HRV, recovery, SpO2).
 * Weight/glucose have no single illness-adverse direction → omitted (their
 * deviation magnitude is still surfaced, direction stays neutral).
 */
export const ADVERSE_DIRECTION: Partial<
  Record<MeasurementType, "up" | "down">
> = {
  RESTING_HEART_RATE: "up",
  PULSE: "up",
  BODY_TEMPERATURE: "up",
  SKIN_TEMPERATURE: "up",
  RESPIRATORY_RATE: "up",
  BLOOD_PRESSURE_SYS: "up",
  BLOOD_PRESSURE_DIA: "up",
  HEART_RATE_VARIABILITY: "down",
  RECOVERY_SCORE: "down",
  OXYGEN_SATURATION: "down",
};

/**
 * Vitals scanned by the illness engine. Superset of the typical-range set
 * plus RECOVERY_SCORE (a canonical wellness signal). The caller only passes
 * series for the vitals the user actually tracks; the rest are skipped.
 */
export const ILLNESS_SCAN_TYPES: MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RECOVERY_SCORE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "RESPIRATORY_RATE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "WEIGHT",
];

/* ── inputs the caller resolves and passes in (pure engine) ──────────── */

/** A per-day mean for one vital (YYYY-MM-DD local day → mean). */
export interface VitalDayPoint {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /** Mean reading for the day. */
  mean: number;
}

/**
 * Everything the engine needs for ONE vital: the baseline-window series
 * (ENDS before the pre-onset lookback — contamination guard lives in the
 * caller's read window) and the episode-window series (pre-onset lookback
 * through the felt-better marker, inclusive).
 */
export interface VitalSeries {
  type: MeasurementType;
  /** Per-day means over the clean baseline window (no episode-span days). */
  baselineDays: VitalDayPoint[];
  /** Per-day means from `onset − lookback` through `resolvedAt` (or today). */
  episodeDays: VitalDayPoint[];
  /**
   * Per-day MAX readings over the episode window, used by the fever red-flag
   * so an evening spike averaged toward normal in `episodeDays` (which carries
   * means) is not masked. Optional — when omitted the flag falls back to the
   * mean series. SpO2 stays mean/min-based (its `worst` is `min`).
   */
  episodeDayMax?: VitalDayPoint[];
}

/**
 * A user-logged fever reading from the illness day-log (`feverC`), keyed by
 * the same local day key as the vital series. The fever red-flag unions this
 * with any passive BODY_TEMPERATURE series so a user logging 39.2 °C for days
 * with no HealthKit thermometer still escalates. Per-day MAX semantics.
 */
export interface DayLogFeverPoint {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /** Logged fever in °C (the day's max when several were logged). */
  feverC: number;
}

/** The dates the engine reasons over, all `YYYY-MM-DD` local day keys. */
export interface EpisodeWindow {
  /** Onset day. */
  onsetDay: string;
  /** Felt-better marker (resolvedAt local day), or null when still active. */
  feltBetterDay: string | null;
  /** Lifecycle — CHRONIC_ONGOING suppresses the recovery-gap. */
  lifecycle: string;
}

export interface IllnessCorrelationInput {
  episodeId: string;
  window: EpisodeWindow;
  /** One entry per vital the user tracks (others omitted by the caller). */
  series: VitalSeries[];
  /**
   * Per-day fever readings from the illness day-log (`feverC`). Unioned into
   * the fever red-flag so the canonical journaling-fever path is visible to
   * escalation even with no passive BODY_TEMPERATURE rows. Optional.
   */
  dayLogFever?: DayLogFeverPoint[];
  /** Provenance source the dominant read resolved against. */
  source: "DAY" | "live" | "none";
  /** Compute time (injected for deterministic tests). */
  now?: Date;
}

/* ── output value (the server-authoritative DTO payload) ─────────────── */

/** One vital's deviation finding on a given day. */
export interface VitalDeviationFinding {
  type: MeasurementType;
  /** The day this finding describes (`YYYY-MM-DD`). */
  day: string;
  /** The day's mean reading. */
  value: number;
  /** Robust baseline center the deviation is measured from. */
  baselineCenter: number;
  /** Signed deviation in robust-SD (k·MAD·scale) units; +above / −below. */
  deviationSd: number;
  /** Which way the reading moved. */
  direction: "above" | "below";
  /** True when this move is the illness-adverse direction for the metric. */
  adverse: boolean;
}

/** A vital's recovery timing within the episode. */
export interface VitalReturnFinding {
  type: MeasurementType;
  /** First day the vital re-entered its band AND stayed in for the window. */
  returnedDay: string | null;
  /** Days from felt-better to physiological return (signed); null if N/A. */
  gapDays: number | null;
}

export interface IllnessCorrelationValue {
  episodeId: string;
  /** "How did it announce itself" — notable pre-onset deviations. */
  preOnset: VitalDeviationFinding[];
  /** "What dropped" — each vital's worst (nadir) deviation in the episode. */
  nadir: VitalDeviationFinding[];
  /** Per-vital physiological-return timing. */
  returns: VitalReturnFinding[];
  /**
   * The headline recovery-gap in days (median of the per-vital gaps), or
   * null when CHRONIC_ONGOING / still active / no vital returned. Positive
   * = the body lagged the felt-better marker.
   */
  recoveryGapDays: number | null;
  /** Felt-better marker echoed for the surface. */
  feltBetterDay: string | null;
  /**
   * Red-flag escalation — a sustained adverse SpO2 drop or sustained fever
   * during the episode. Retrospective, but the copy must escalate ("if this
   * recurs, seek care"), NEVER reassure. Empty when nothing tripped.
   */
  redFlags: IllnessRedFlag[];
}

export interface IllnessRedFlag {
  type: MeasurementType;
  /** A short stable reason key the i18n layer renders (not free text). */
  reason: "sustained_low_spo2" | "sustained_fever";
  /** The worst observed value during the flagged run. */
  worstValue: number;
  /** Consecutive days the adverse threshold held. */
  days: number;
}

/* ── red-flag thresholds (clinical floors, conservative) ─────────────── */

/** SpO2 at/below this for ≥ RED_FLAG_RUN_DAYS escalates. */
const SPO2_RED_FLAG = 92;
/** Body temperature at/above this (°C) for ≥ RED_FLAG_RUN_DAYS escalates. */
const FEVER_RED_FLAG = 38.5;
/** Consecutive days an adverse clinical threshold must hold to escalate. */
const RED_FLAG_RUN_DAYS = 3;

/* ── pure helpers ─────────────────────────────────────────────────────── */

/** Robust band for a vital, or null below the min-baseline-days floor. */
function bandFor(series: VitalSeries): {
  center: number;
  spread: number;
} | null {
  if (series.baselineDays.length < MIN_BASELINE_DAYS) return null;
  const band = buildBaselineBand(series.baselineDays.map((p) => p.mean));
  if (!band || band.spread <= 0) return null;
  return { center: band.center, spread: band.spread };
}

/** Signed deviation of a value in robust-SD units (spread = k·MAD·scale). */
function deviationSd(value: number, center: number, spread: number): number {
  return (value - center) / spread;
}

/** Build a deviation finding for one day/value against a band. */
function finding(
  type: MeasurementType,
  day: string,
  value: number,
  center: number,
  spread: number,
): VitalDeviationFinding {
  const sd = deviationSd(value, center, spread);
  const direction: "above" | "below" = sd >= 0 ? "above" : "below";
  const adverseDir = ADVERSE_DIRECTION[type];
  const adverse =
    (adverseDir === "up" && direction === "above") ||
    (adverseDir === "down" && direction === "below");
  return {
    type,
    day,
    value,
    baselineCenter: center,
    deviationSd: Math.round(sd * 100) / 100,
    direction,
    adverse,
  };
}

/** Order day keys chronologically. */
function byDay(a: { day: string }, b: { day: string }): number {
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}

/* ── the engine ───────────────────────────────────────────────────────── */

/**
 * Compute the retrospective correlation findings for one episode. Pure given
 * its inputs — the caller resolves the reads (rollup tier with a live-SQL
 * fallback) and passes the series in. Returns a gated `Derived<T>`: below the
 * coverage floor it returns `insufficient` (never a fabricated finding).
 */
export function computeIllnessCorrelation(
  input: IllnessCorrelationInput,
): Derived<IllnessCorrelationValue> {
  const now = input.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  const { window } = input;

  // Only vitals with a trustworthy own-baseline band participate.
  const banded = input.series
    .map((s) => ({ series: s, band: bandFor(s) }))
    .filter(
      (
        b,
      ): b is {
        series: VitalSeries;
        band: { center: number; spread: number };
      } => b.band !== null,
    );

  const inputs = banded.map((b) => String(b.series.type));
  const provenance = {
    inputs,
    source: input.source,
    windowDays: BASELINE_WINDOW_DAYS,
    computedAt,
  };

  // Coverage: how many distinct episode days carry ANY banded vital reading.
  const episodeDayKeys = new Set<string>();
  for (const b of banded) {
    for (const p of b.series.episodeDays) {
      if (p.day >= window.onsetDay) episodeDayKeys.add(p.day);
    }
  }
  const coverageDays = episodeDayKeys.size;

  if (banded.length === 0 || coverageDays < MIN_EPISODE_COVERAGE_DAYS) {
    const { coverage } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: banded.length,
      historyDays: coverageDays,
      missing: banded.length === 0 ? ILLNESS_SCAN_TYPES.map(String) : [],
      fullHistoryDays: MIN_EPISODE_COVERAGE_DAYS,
    });
    return buildInsufficient<IllnessCorrelationValue>({
      coverage,
      provenance,
      reason:
        banded.length === 0
          ? "no_baselined_vitals"
          : "insufficient_episode_coverage",
    });
  }

  const preOnset: VitalDeviationFinding[] = [];
  const nadir: VitalDeviationFinding[] = [];
  const returns: VitalReturnFinding[] = [];

  for (const { series, band } of banded) {
    const { type } = series;
    const { center, spread } = band;
    const episode = [...series.episodeDays].sort(byDay);

    // 1) Pre-onset scan: lookback window strictly before onset.
    const pre = episode.filter((p) => p.day < window.onsetDay);
    let worstPre: VitalDeviationFinding | null = null;
    for (const p of pre) {
      const f = finding(type, p.day, p.mean, center, spread);
      if (
        Math.abs(f.deviationSd) >= NOTABLE_SD &&
        (worstPre === null ||
          Math.abs(f.deviationSd) > Math.abs(worstPre.deviationSd))
      ) {
        worstPre = f;
      }
    }
    if (worstPre) preOnset.push(worstPre);

    // 2) Nadir: worst deviation across the active span (onset → end).
    const active = episode.filter((p) => p.day >= window.onsetDay);
    let worstActive: VitalDeviationFinding | null = null;
    // The chronological index of the FIRST notably-deviated active day — the
    // anchor the recovery search must start AFTER (an early in-band run before
    // the vital ever deviated is not a "return", it is the run-up).
    let firstDeviationIndex = -1;
    active.forEach((p, i) => {
      const f = finding(type, p.day, p.mean, center, spread);
      if (Math.abs(f.deviationSd) >= NOTABLE_SD) {
        if (firstDeviationIndex === -1) firstDeviationIndex = i;
        if (
          worstActive === null ||
          Math.abs(f.deviationSd) > Math.abs(worstActive.deviationSd)
        ) {
          worstActive = f;
        }
      }
    });
    if (worstActive) nadir.push(worstActive);

    // 3) Physiological return: only meaningful once the vital has actually
    //    deviated. Anchor the search AFTER the first notable deviation so an
    //    early in-band run can never be reported as a return BEFORE the
    //    deviation (which yielded a spurious negative gap). Excluded for
    //    CHRONIC_ONGOING (no recovered date by design).
    if (firstDeviationIndex >= 0 && window.lifecycle !== "CHRONIC_ONGOING") {
      const returnedDay = firstStableReturn(
        active,
        center,
        spread,
        firstDeviationIndex,
      );
      const gapDays =
        returnedDay && window.feltBetterDay
          ? dayDiff(window.feltBetterDay, returnedDay)
          : null;
      returns.push({ type, returnedDay, gapDays });
    }
  }

  // Red-flag escalation runs DECOUPLED from the banded loop: it scans the raw
  // episode days for SpO2 + temperature against ABSOLUTE clinical floors, so a
  // rock-steady (MAD=0) vital that drops the band filter still escalates — the
  // safety-critical output must fire for exactly the low-variance population it
  // matters for. The fever path additionally unions the day-log `feverC`
  // series so a user journaling fever with no thermometer is still seen.
  const redFlags = detectRedFlags(input);

  // Headline gap = median of the per-vital signed gaps (robust to one vital
  // recovering oddly). Null for CHRONIC_ONGOING / still active / no returns.
  const gaps = returns
    .map((r) => r.gapDays)
    .filter((g): g is number => g !== null);
  const recoveryGapDays =
    window.lifecycle === "CHRONIC_ONGOING" || gaps.length === 0
      ? null
      : Math.round(median(gaps));

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: banded.length,
    historyDays: coverageDays,
    missing: [],
    fullHistoryDays: Math.max(MIN_EPISODE_COVERAGE_DAYS, 14),
  });

  return buildOk<IllnessCorrelationValue>({
    value: {
      episodeId: input.episodeId,
      preOnset: preOnset.sort(
        (a, b) => Math.abs(b.deviationSd) - Math.abs(a.deviationSd),
      ),
      nadir: nadir.sort(
        (a, b) => Math.abs(b.deviationSd) - Math.abs(a.deviationSd),
      ),
      returns,
      recoveryGapDays,
      feltBetterDay: window.feltBetterDay,
      redFlags,
    },
    coverage,
    confidence,
    provenance,
  });
}

/**
 * First day in `active` (chronological), starting at `fromIndex`, where the
 * vital is in-band AND stays in-band for the next `RETURN_STABILITY_DAYS`
 * observed days. Null when it never settles. "In-band" = |deviation| <
 * NOTABLE_SD. `fromIndex` pins the search to AFTER the first deviation so an
 * early in-band run (the run-up to the illness) is never mistaken for a return.
 */
function firstStableReturn(
  active: VitalDayPoint[],
  center: number,
  spread: number,
  fromIndex: number,
): string | null {
  const inBand = active.map((p) => ({
    day: p.day,
    in: Math.abs(deviationSd(p.mean, center, spread)) < NOTABLE_SD,
  }));
  for (let i = Math.max(0, fromIndex); i < inBand.length; i++) {
    if (!inBand[i].in) continue;
    let run = 0;
    for (let j = i; j < inBand.length && inBand[j].in; j++) run++;
    if (run >= RETURN_STABILITY_DAYS) return inBand[i].day;
  }
  return null;
}

/**
 * Detect the retrospective red flags — DECOUPLED from the banded loop and the
 * own-baseline band entirely. SpO2 and temperature escalate against ABSOLUTE
 * clinical floors over the RAW episode days (active span), so a rock-steady
 * (MAD=0) vital whose band was dropped still escalates. The fever path unions
 * the passive BODY_TEMPERATURE series (per-day max when available) with the
 * day-log `feverC` series so the canonical journaling-fever path is visible.
 * Conservative; escalation copy lives in the i18n layer.
 */
function detectRedFlags(input: IllnessCorrelationInput): IllnessRedFlag[] {
  const { window } = input;
  const flags: IllnessRedFlag[] = [];
  const inActive = (p: { day: string }) => p.day >= window.onsetDay;

  // SpO2 — sustained low. Mean series is the floor; use per-day-max only when
  // it would HELP (SpO2's worst is the min, so means are conservative enough).
  const spo2 = input.series.find((s) => s.type === "OXYGEN_SATURATION");
  if (spo2) {
    const flag = runFlag(
      spo2.episodeDays.filter(inActive),
      (v) => v <= SPO2_RED_FLAG,
      "sustained_low_spo2",
      "OXYGEN_SATURATION",
      "min",
    );
    if (flag) flags.push(flag);
  }

  // Fever — union the passive temperature series (per-day MAX preferred so an
  // evening spike is not masked by a daily mean) with the day-log feverC.
  const temp = input.series.find((s) => s.type === "BODY_TEMPERATURE");
  const tempPoints = temp
    ? (temp.episodeDayMax ?? temp.episodeDays).filter(inActive)
    : [];
  const feverByDay = new Map<string, number>();
  for (const p of tempPoints) {
    feverByDay.set(p.day, Math.max(feverByDay.get(p.day) ?? -Infinity, p.mean));
  }
  for (const p of input.dayLogFever ?? []) {
    if (!inActive(p)) continue;
    feverByDay.set(
      p.day,
      Math.max(feverByDay.get(p.day) ?? -Infinity, p.feverC),
    );
  }
  if (feverByDay.size > 0) {
    const fevPoints: VitalDayPoint[] = [...feverByDay.entries()].map(
      ([day, mean]) => ({ day, mean }),
    );
    const flag = runFlag(
      fevPoints,
      (v) => v >= FEVER_RED_FLAG,
      "sustained_fever",
      "BODY_TEMPERATURE",
      "max",
    );
    if (flag) flags.push(flag);
  }

  return flags;
}

/** Longest consecutive run matching `predicate`; flag when ≥ RED_FLAG_RUN_DAYS. */
function runFlag(
  sorted: VitalDayPoint[],
  predicate: (v: number) => boolean,
  reason: IllnessRedFlag["reason"],
  type: MeasurementType,
  worst: "min" | "max",
): IllnessRedFlag | null {
  let bestRun = 0;
  let bestWorst: number | null = null;
  let run = 0;
  let runWorst: number | null = null;
  for (const p of sorted) {
    if (predicate(p.mean)) {
      run++;
      runWorst =
        runWorst === null
          ? p.mean
          : worst === "min"
            ? Math.min(runWorst, p.mean)
            : Math.max(runWorst, p.mean);
      if (run > bestRun) {
        bestRun = run;
        bestWorst = runWorst;
      }
    } else {
      run = 0;
      runWorst = null;
    }
  }
  if (bestRun >= RED_FLAG_RUN_DAYS && bestWorst !== null) {
    return { type, reason, worstValue: bestWorst, days: bestRun };
  }
  return null;
}

/** Whole-day signed difference `to − from` for two `YYYY-MM-DD` keys. */
export function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
