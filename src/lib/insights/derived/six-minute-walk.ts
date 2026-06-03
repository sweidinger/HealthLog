/**
 * v1.10.3 — additive HealthKit signal: estimated six-minute-walk distance,
 * re-framed against a published reference equation.
 *
 * `computeSixMinuteWalkBand(userId, profile, opts)` takes the device's
 * ESTIMATED 6-minute-walk distance (HealthKit `sixMinuteWalkTestDistance` —
 * an estimate, NOT a supervised in-clinic 6MWT) and re-frames it as a
 * percent-of-predicted against the Enright & Sherrill 1998 reference
 * equation for healthy adults. It NEVER recomputes the distance and NEVER
 * derives its own equation — this is the `passthrough-reframe` archetype,
 * the same posture `fitness-age.ts` takes against VO₂max.
 *
 *   - **percentOfPredicted** — distance ÷ Enright-predicted × 100, placed in
 *     a green/yellow/red band (≥ 80% green; 60–80% yellow; < 60% red),
 *     `null` when the demographics the equation needs are absent (sex,
 *     adult age, height, AND weight — the published full equation). With no
 *     band the metric still surfaces the raw distance + trend, never a
 *     fabricated placement.
 *   - **trend** — signed latest-vs-prior delta, surfaced only once ≥ 3
 *     readings exist (the catalogue's trend gate).
 *
 * Standard: Enright & Sherrill 1998 (reference equations) + ATS 2002 (the
 * test standard) — cited in `norms.ts`. Apple's value is framed as
 * "estimated", surfaced + trended, never re-derived. No diagnosis: a low
 * percent is a functional-capacity awareness signal, not a verdict.
 *
 * Server-only — reads the latest `SIX_MINUTE_WALK_DISTANCE` + `WEIGHT` rows
 * via Prisma; age/height/sex come from the caller's profile. The placement
 * helper is exported pure for the unit tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { predictSixMinuteWalkDistance } from "./norms";
import type { BaselineProfile } from "./baseline";
import type { Derived, DerivedProvenanceSource } from "./types";

/** Band placement, same green/yellow/red vocabulary the tokens speak. */
export type SixMinuteWalkBand = "green" | "yellow" | "red";

const SIX_MINUTE_WALK_TYPE: MeasurementType = "SIX_MINUTE_WALK_DISTANCE";
const WEIGHT_TYPE: MeasurementType = "WEIGHT";
/** Readings needed before the latest-vs-prior trend delta is surfaced. */
const MIN_TREND_READINGS = 3;
/**
 * The estimate refreshes at most every few days; widen the read window so the
 * latest value + trend survive sparse cadence (matches `fitness-age.ts`).
 */
const DEFAULT_WINDOW_DAYS = 180;
/** A weight reading older than this no longer reflects current capacity. */
const WEIGHT_WINDOW_DAYS = 90;

/** Percent-of-predicted band thresholds (% of Enright-predicted). */
const GREEN_PCT = 80;
const YELLOW_PCT = 60;

/** The successful `value` payload for the 6-minute-walk band. */
export interface SixMinuteWalkValue {
  /** The latest device-estimated 6-minute-walk distance (m). */
  distanceM: number;
  /** Enright-predicted distance for the profile (m), or `null` without demographics. */
  predictedM: number | null;
  /** Distance ÷ predicted × 100, rounded; `null` without a prediction. */
  percentOfPredicted: number | null;
  /** Green/yellow/red placement, or `null` without a prediction. */
  band: SixMinuteWalkBand | null;
  /** Signed latest-vs-prior delta (m); `null` until ≥ 3 readings. */
  trendDelta: number | null;
  /** Distinct readings in the window. */
  readingCount: number;
}

/**
 * Place a percent-of-predicted in a band. Pure. ≥ 80% green; 60–80% yellow;
 * < 60% red; `null` when the percent is absent.
 */
export function placeSixMinuteWalkBand(
  percentOfPredicted: number | null,
): SixMinuteWalkBand | null {
  if (percentOfPredicted == null) return null;
  if (percentOfPredicted >= GREEN_PCT) return "green";
  if (percentOfPredicted >= YELLOW_PCT) return "yellow";
  return "red";
}

/**
 * Estimated six-minute-walk band — passthrough re-frame of
 * `SIX_MINUTE_WALK_DISTANCE`. Returns `insufficient` when no reading exists;
 * otherwise an `ok` value carrying the latest distance, its
 * percent-of-predicted placement (when demographics allow), and a trend once
 * ≥ 3 readings exist. With incomplete demographics the band is `null` and the
 * value + trend still surface — never a fabricated placement.
 */
export async function computeSixMinuteWalkBand(
  userId: string,
  profile: BaselineProfile,
  opts?: { windowDays?: number; now?: Date },
): Promise<Derived<SixMinuteWalkValue>> {
  const now = opts?.now ?? new Date();
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const computedAt = nowProvenanceTimestamp(now);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: SIX_MINUTE_WALK_TYPE,
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
      missing: [SIX_MINUTE_WALK_TYPE],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<SixMinuteWalkValue>({
      coverage,
      provenance: {
        inputs: [SIX_MINUTE_WALK_TYPE],
        source: "none",
        windowDays,
        computedAt,
      },
      reason: "no_readings_in_window",
    });
  }

  const distanceM = rows[0].value;

  // The Enright equation needs a recent weight; read the latest in a tighter
  // window. Absent → predicted is null and the band is suppressed.
  const weightSince = new Date(
    now.getTime() - WEIGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const weightRow = await prisma.measurement.findFirst({
    where: {
      userId,
      type: WEIGHT_TYPE,
      deletedAt: null,
      measuredAt: { gte: weightSince },
    },
    orderBy: { measuredAt: "desc" },
    select: { value: true },
  });

  const predictedM = predictSixMinuteWalkDistance(
    profile.ageYears,
    profile.heightCm ?? null,
    weightRow?.value ?? null,
    profile.sex,
  );
  const percentOfPredicted =
    predictedM != null && predictedM > 0
      ? Math.round((distanceM / predictedM) * 100)
      : null;
  const band = placeSixMinuteWalkBand(percentOfPredicted);
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

  return buildOk<SixMinuteWalkValue>({
    value: {
      distanceM,
      predictedM: predictedM != null ? Math.round(predictedM) : null,
      percentOfPredicted,
      band,
      trendDelta,
      readingCount: rows.length,
    },
    coverage,
    confidence,
    provenance: {
      inputs: [SIX_MINUTE_WALK_TYPE],
      source,
      windowDays,
      computedAt,
    },
  });
}
