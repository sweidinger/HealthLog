/**
 * v1.10.0 — catalogue metric #4: cardio-fitness band / "Fitness Age" frame.
 *
 * `computeFitnessAge(userId, profile, opts)` re-frames the device-computed
 * `VO2_MAX` passthrough (HealthKit `vo2Max` / Withings) against a published
 * age × sex norm band. It NEVER recomputes VO₂max — the number is the
 * device's; this layer only places it in a band and trends it.
 *
 *   - **band** — the latest VO₂max placed against the FRIEND-registry
 *     50th-percentile band for the user's age decade × sex
 *     (`lookupNormalRange("VO2_MAX", age, sex)`). At/above the band's upper
 *     edge → "high"/green; inside → "fair"/yellow; below the lower edge →
 *     "low"/red. With no demographics the band is absent and the metric
 *     still surfaces the value + trend, never a fabricated placement.
 *   - **fitnessAgeDeltaYears** — an honest, low-precision re-frame: where
 *     the user's VO₂max sits relative to the same-sex age curve, expressed
 *     as a coarse "≈N years younger/older" band (rounded to whole years,
 *     never a false-precise "Fitness Age = 41"). Absent without sex.
 *   - **trend** — signed delta of the latest vs the prior reading, surfaced
 *     only when ≥ 3 readings exist (the catalogue's trend gate).
 *
 * Standard: Kaminsky et al. 2015, "Reference Standards for Cardiorespiratory
 * Fitness Measured With Cardiopulmonary Exercise Testing" (FRIEND registry),
 * Mayo Clinic Proceedings 90(11):1515–1523. Frame: Apple's low-cardio-fitness
 * cutoffs. Surfaced + trended, never re-derived.
 *
 * Server-only — reads `VO2_MAX` rows via Prisma. The placement helpers are
 * exported pure so the unit tests assert the band logic without a DB.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { lookupNormalRange } from "./norms";
import type { BaselineProfile } from "./baseline";
import type { Derived, DerivedProvenanceSource } from "./types";

/**
 * Norm-band placement, in the same green/yellow/red vocabulary the
 * design-system `band-tokens` speak. Declared here so the server compute
 * layer never imports from the component tree.
 */
export type FitnessBand = "green" | "yellow" | "red";

const VO2_MAX_TYPE: MeasurementType = "VO2_MAX";
/** Readings needed before the latest-vs-prior trend delta is surfaced. */
const MIN_TREND_READINGS = 3;
/**
 * VO₂max readings arrive at most every few days; widen the read window so
 * the latest value + trend survive sparse cadence. 180 days is the
 * catalogue's "trend if ≥ 3" horizon.
 */
const DEFAULT_WINDOW_DAYS = 180;
/**
 * Map a VO₂max gap (mL/(kg·min)) to a coarse "fitness-age year" band. ~1
 * mL/(kg·min) per year is the population-average decline anchor — used ONLY
 * as a low-precision presentation re-frame, rounded to whole years.
 */
const VO2_PER_YEAR = 1;

/** The successful `value` payload for the cardio-fitness band. */
export interface FitnessAgeValue {
  /** The latest device VO₂max reading (mL/(kg·min)). */
  vo2Max: number;
  /** Norm-band placement, or `null` when demographics are absent. */
  band: FitnessBand | null;
  /**
   * Coarse "≈N years younger (−) / older (+)" re-frame vs the same-sex age
   * curve. Whole years; `null` without a usable norm band.
   */
  fitnessAgeDeltaYears: number | null;
  /** The age × sex reference band the placement used, when available. */
  referenceBand: { low: number; high: number } | null;
  /** Signed latest-vs-prior delta; `null` until ≥ 3 readings. */
  trendDelta: number | null;
  /** Distinct readings in the window. */
  readingCount: number;
}

/**
 * Place a VO₂max value in a band against its age × sex reference. Pure.
 * Above the reference high → green; below the low → red; inside → yellow.
 */
export function placeVo2Band(
  vo2Max: number,
  reference: { low: number; high: number } | null,
): FitnessBand | null {
  if (!reference) return null;
  if (vo2Max >= reference.high) return "green";
  if (vo2Max < reference.low) return "red";
  return "yellow";
}

/**
 * Express a VO₂max value as a coarse fitness-age delta in whole years vs the
 * midpoint of its age × sex reference band. Negative = fitter-than-typical
 * ("younger"); positive = below-typical ("older"). Pure; `null` without a
 * reference.
 */
export function fitnessAgeDeltaYears(
  vo2Max: number,
  reference: { low: number; high: number } | null,
): number | null {
  if (!reference) return null;
  const midpoint = (reference.low + reference.high) / 2;
  // Fitter than the age midpoint reads as "younger" (negative years).
  return -Math.round((vo2Max - midpoint) / VO2_PER_YEAR);
}

/**
 * Cardio-fitness band — passthrough re-frame of `VO2_MAX`. Returns
 * `insufficient` when no reading exists; otherwise an `ok` value carrying
 * the latest reading, its norm-band placement (when demographics allow),
 * and a trend once ≥ 3 readings exist.
 */
export async function computeFitnessAge(
  userId: string,
  profile: BaselineProfile,
  opts?: { windowDays?: number; now?: Date },
): Promise<Derived<FitnessAgeValue>> {
  const now = opts?.now ?? new Date();
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const computedAt = nowProvenanceTimestamp(now);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: VO2_MAX_TYPE,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "desc" },
    select: { value: true },
  });

  if (rows.length === 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: [VO2_MAX_TYPE],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<FitnessAgeValue>({
      coverage,
      provenance: {
        inputs: [VO2_MAX_TYPE],
        source: "none",
        windowDays,
        computedAt,
      },
      reason: "no_readings_in_window",
    });
  }

  const vo2Max = rows[0].value;
  const reference = lookupNormalRange("VO2_MAX", profile.ageYears, profile.sex);
  const band = placeVo2Band(vo2Max, reference);
  const deltaYears = fitnessAgeDeltaYears(vo2Max, reference);
  const trendDelta =
    rows.length >= MIN_TREND_READINGS ? rows[0].value - rows[1].value : null;

  const source: DerivedProvenanceSource = "live";
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: rows.length,
    missing: [],
    fullHistoryDays: MIN_TREND_READINGS,
  });

  return buildOk<FitnessAgeValue>({
    value: {
      vo2Max,
      band,
      fitnessAgeDeltaYears: deltaYears,
      referenceBand: reference,
      trendDelta,
      readingCount: rows.length,
    },
    coverage,
    confidence,
    provenance: {
      inputs: [VO2_MAX_TYPE],
      source,
      windowDays,
      computedAt,
    },
  });
}
