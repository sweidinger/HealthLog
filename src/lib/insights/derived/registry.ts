/**
 * v1.10.0 — the closed `DERIVED_METRIC_ID` enum + per-metric metadata.
 *
 * One single source the generic `/api/insights/derived` route, the
 * OpenAPI registration, and the QA inventory all share. An id added here
 * is accepted by the route automatically; an unknown id 422s against the
 * closed enum (the v1.8.7.1 `metric-status` pattern).
 *
 * Wave 1 implements ONE metric end-to-end as the reference: the personal
 * typical-range vitals baseline (`VITALS_BASELINE`). The other catalogue
 * metrics are registered here as metadata STUBS — their `archetype`
 * documents the shape later waves plug in, but their compute functions
 * land in W2/W3 (`fitness-age.ts`, `vascular-age.ts`, `sleep-score.ts`,
 * `readiness.ts`, the coincident-deviation flag). A stubbed metric routed
 * before its compute lands returns `insufficient` via the dispatcher's
 * `not-implemented` guard, never a fabricated value.
 *
 * Metadata only — no compute, no server imports — so this stays
 * client-safe and the route enum / OpenAPI can import it freely.
 */
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * The closed set of derived-metric ids. The single vocabulary the route
 * query param, the OpenAPI enum, and the cache scope all speak.
 */
export type DerivedMetricId =
  /** FLAGSHIP (W1): personal typical-range band for one vital. */
  | "VITALS_BASELINE"
  /** W2: VO₂max → age/sex band + chronological-age delta (passthrough re-frame). */
  | "FITNESS_AGE"
  /** W2: VASCULAR_AGE/PWV → age-delta band (passthrough re-frame). */
  | "VASCULAR_AGE_DELTA"
  /** W3: transparent sleep composite. */
  | "SLEEP_SCORE"
  /** W3: wellness/readiness index (extends the health-score blend). */
  | "READINESS"
  /** W3: multi-signal coincident-deviation early-strain flag. */
  | "COINCIDENT_DEVIATION"
  /** W2: HRV (SDNN) personal-trend balance band (reuses the baseline engine). */
  | "HRV_BALANCE"
  /** W2: BMI from weight + height (fallback when no device BMI). */
  | "BMI";

/** Archetype of a derived metric — drives shaping + the QA inventory. */
export type DerivedArchetype =
  /** Renders whenever its single input series exists; no min-input threshold beyond its own history. */
  | "any-user-baseline"
  /** A device-computed value re-framed against a norm band — never recomputed. */
  | "passthrough-reframe"
  /** Needs a minimum-inputs threshold, reweights around missing inputs, shows coverage/confidence. */
  | "composite";

export interface DerivedMetricMeta {
  id: DerivedMetricId;
  /** Stable English display name (surfaces localise their own prose). */
  displayName: string;
  archetype: DerivedArchetype;
  /**
   * The named inputs the metric reads. For `VITALS_BASELINE` these are
   * `MeasurementType` names (the caller selects one via the route's
   * `type` opt); for a composite the set may also name non-measurement
   * signals (e.g. "MOOD", a derived sub-score) the coverage model counts
   * against — hence `string`, not `MeasurementType`.
   */
  inputs: string[];
  /**
   * Minimum distinct history-days an input needs before a band/headline
   * is produced. Below the floor the metric returns `insufficient`.
   */
  minHistoryDays: number;
  /**
   * For a composite: the minimum number of `inputs` that must be present
   * before a headline is produced (no 1-of-N headline). `1` for
   * any-user / passthrough metrics.
   */
  minInputs: number;
  /** `true` once a compute function backs this id; `false` = W2/W3 stub. */
  implemented: boolean;
}

/**
 * The vitals the typical-range baseline engine supports. The route's
 * `type` opt must name one of these; any other type 422s. Mirrors the
 * metric-1 input set from the catalogue (§1, row 1).
 */
export const VITALS_BASELINE_TYPES: MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "RESPIRATORY_RATE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "SKIN_TEMPERATURE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "BLOOD_GLUCOSE",
  "PULSE",
  "WEIGHT",
];

const REGISTRY: Record<DerivedMetricId, DerivedMetricMeta> = {
  VITALS_BASELINE: {
    id: "VITALS_BASELINE",
    displayName: "Personal typical range",
    archetype: "any-user-baseline",
    inputs: VITALS_BASELINE_TYPES,
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  FITNESS_AGE: {
    id: "FITNESS_AGE",
    displayName: "Cardio-fitness band",
    archetype: "passthrough-reframe",
    inputs: ["VO2_MAX"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  VASCULAR_AGE_DELTA: {
    id: "VASCULAR_AGE_DELTA",
    displayName: "Vascular-age delta",
    archetype: "passthrough-reframe",
    inputs: ["VASCULAR_AGE", "PULSE_WAVE_VELOCITY"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: true,
  },
  SLEEP_SCORE: {
    id: "SLEEP_SCORE",
    displayName: "Sleep score",
    archetype: "composite",
    inputs: ["SLEEP_DURATION"],
    minHistoryDays: 1,
    minInputs: 1,
    implemented: false,
  },
  READINESS: {
    id: "READINESS",
    displayName: "Wellness / readiness index",
    archetype: "composite",
    inputs: [
      "RESTING_HEART_RATE",
      "HEART_RATE_VARIABILITY",
      "SLEEP_DURATION",
      "RESPIRATORY_RATE",
      "MOOD",
    ],
    minHistoryDays: 7,
    minInputs: 2,
    implemented: false,
  },
  COINCIDENT_DEVIATION: {
    id: "COINCIDENT_DEVIATION",
    displayName: "Coincident-deviation flag",
    archetype: "composite",
    inputs: VITALS_BASELINE_TYPES,
    minHistoryDays: 7,
    minInputs: 2,
    implemented: false,
  },
  HRV_BALANCE: {
    id: "HRV_BALANCE",
    displayName: "HRV (SDNN) balance",
    archetype: "any-user-baseline",
    inputs: ["HEART_RATE_VARIABILITY"],
    minHistoryDays: 7,
    minInputs: 1,
    implemented: true,
  },
  BMI: {
    id: "BMI",
    displayName: "Body-mass index",
    archetype: "any-user-baseline",
    inputs: ["WEIGHT", "HEIGHT"],
    minHistoryDays: 1,
    minInputs: 2,
    implemented: true,
  },
};

/** Closed set of ids the generic route accepts (Zod enum source). */
export const DERIVED_METRIC_IDS = Object.keys(REGISTRY) as DerivedMetricId[];

/** Type guard narrowing an arbitrary string to a registered derived id. */
export function isDerivedMetricId(value: string): value is DerivedMetricId {
  return Object.prototype.hasOwnProperty.call(REGISTRY, value);
}

/** Resolve a derived metric's metadata, or `null` when unregistered. */
export function getDerivedMetricMeta(
  metric: string,
): DerivedMetricMeta | null {
  return isDerivedMetricId(metric) ? REGISTRY[metric] : null;
}

/** `true` when the type is a vital the baseline engine supports. */
export function isVitalsBaselineType(type: string): boolean {
  return (VITALS_BASELINE_TYPES as string[]).includes(type);
}
