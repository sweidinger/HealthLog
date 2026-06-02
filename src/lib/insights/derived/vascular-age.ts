/**
 * v1.10.0 — catalogue metric #5: vascular-age delta frame.
 *
 * `computeVascularAgeDelta(userId, profile, opts)` re-frames the
 * device-computed `VASCULAR_AGE` passthrough (Withings meastype 155, Body
 * Scan — itself a composite of pulse-wave velocity + chronological age)
 * against the user's chronological age. It NEVER recomputes the value — the
 * underlying arterial-stiffness science is Withings'; this layer surfaces
 * and trends the delta only.
 *
 *   - **deltaYears** = latest `VASCULAR_AGE` − chronological age. Negative =
 *     vascular age below chronological ("better"); positive = above. `null`
 *     when the profile has no age.
 *   - **band** — optimal (≤ −2 yr, green) / normal (within ±2 yr, yellow) /
 *     sub-optimal (≥ +2 yr, red), a relative wellness indicator, NOT a
 *     cardiovascular-risk diagnosis.
 *   - **trend** — signed latest-vs-prior delta of the vascular-age value,
 *     surfaced only when ≥ 3 readings exist.
 *   - **pulseWaveVelocity** — the latest `PULSE_WAVE_VELOCITY` (m/s) when
 *     present, carried for context (the physical driver of the composite).
 *
 * Standard: Vlachopoulos et al. 2010, "Prediction of cardiovascular events
 * and all-cause mortality with arterial stiffness", Journal of the American
 * College of Cardiology 55(13):1318–1327. Frame: Withings' own relative
 * wellness indicator — surfaced + trended, never re-derived, no medical
 * claim.
 *
 * Server-only — reads `VASCULAR_AGE` + `PULSE_WAVE_VELOCITY` rows via Prisma.
 * The band/delta helpers are exported pure for the unit tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import type { BaselineProfile } from "./baseline";
import type { Derived, DerivedProvenanceSource } from "./types";

const VASCULAR_AGE_TYPE: MeasurementType = "VASCULAR_AGE";
const PWV_TYPE: MeasurementType = "PULSE_WAVE_VELOCITY";
/** Readings needed before the latest-vs-prior trend delta is surfaced. */
const MIN_TREND_READINGS = 3;
/** Vascular-age readings are infrequent; widen the window like fitness age. */
const DEFAULT_WINDOW_DAYS = 365;
/** ±2-year dead-band around chronological age that reads as "normal". */
const NORMAL_BAND_YEARS = 2;

/** Green/yellow/red placement, same vocabulary as the design-system tokens. */
export type VascularBand = "green" | "yellow" | "red";

/** The successful `value` payload for the vascular-age delta. */
export interface VascularAgeDeltaValue {
  /** Latest device vascular-age reading (years). */
  vascularAge: number;
  /** vascularAge − chronological age (years); `null` without a profile age. */
  deltaYears: number | null;
  /** Relative-wellness placement; `null` without a delta. */
  band: VascularBand | null;
  /** Latest pulse-wave velocity (m/s), the composite's physical driver. */
  pulseWaveVelocity: number | null;
  /** Signed latest-vs-prior vascular-age delta; `null` until ≥ 3 readings. */
  trendDelta: number | null;
  /** Distinct vascular-age readings in the window. */
  readingCount: number;
}

/**
 * Place a vascular-age delta in a band. Pure. ≤ −2 yr → green (vascular age
 * comfortably below chronological); within ±2 yr → yellow; ≥ +2 yr → red.
 */
export function placeVascularBand(deltaYears: number | null): VascularBand | null {
  if (deltaYears == null) return null;
  if (deltaYears <= -NORMAL_BAND_YEARS) return "green";
  if (deltaYears >= NORMAL_BAND_YEARS) return "red";
  return "yellow";
}

/**
 * Vascular-age delta — passthrough re-frame of `VASCULAR_AGE`. Returns
 * `insufficient` when no reading exists; otherwise an `ok` value carrying
 * the latest reading, its delta vs chronological age (when known), its band,
 * the latest PWV for context, and a trend once ≥ 3 readings exist.
 */
export async function computeVascularAgeDelta(
  userId: string,
  profile: BaselineProfile,
  opts?: { windowDays?: number; now?: Date },
): Promise<Derived<VascularAgeDeltaValue>> {
  const now = opts?.now ?? new Date();
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const computedAt = nowProvenanceTimestamp(now);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [vascularRows, pwvRow] = await Promise.all([
    prisma.measurement.findMany({
      where: {
        userId,
        type: VASCULAR_AGE_TYPE,
        deletedAt: null,
        measuredAt: { gte: since },
      },
      orderBy: { measuredAt: "desc" },
      select: { value: true },
    }),
    prisma.measurement.findFirst({
      where: {
        userId,
        type: PWV_TYPE,
        deletedAt: null,
        measuredAt: { gte: since },
      },
      orderBy: { measuredAt: "desc" },
      select: { value: true },
    }),
  ]);

  if (vascularRows.length === 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: [VASCULAR_AGE_TYPE],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<VascularAgeDeltaValue>({
      coverage,
      provenance: {
        inputs: [VASCULAR_AGE_TYPE],
        source: "none",
        windowDays,
        computedAt,
      },
      reason: "no_readings_in_window",
    });
  }

  const vascularAge = vascularRows[0].value;
  const deltaYears =
    profile.ageYears != null && Number.isFinite(profile.ageYears)
      ? vascularAge - profile.ageYears
      : null;
  const band = placeVascularBand(deltaYears);
  const trendDelta =
    vascularRows.length >= MIN_TREND_READINGS
      ? vascularRows[0].value - vascularRows[1].value
      : null;

  const inputs = [VASCULAR_AGE_TYPE, ...(pwvRow ? [PWV_TYPE] : [])];
  const source: DerivedProvenanceSource = "live";
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: vascularRows.length,
    missing: [],
    fullHistoryDays: MIN_TREND_READINGS,
  });

  return buildOk<VascularAgeDeltaValue>({
    value: {
      vascularAge,
      deltaYears,
      band,
      pulseWaveVelocity: pwvRow?.value ?? null,
      trendDelta,
      readingCount: vascularRows.length,
    },
    coverage,
    confidence,
    provenance: {
      inputs,
      source,
      windowDays,
      computedAt,
    },
  });
}
