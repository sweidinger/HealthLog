import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";
import { COACH_SOURCE_DOMAIN_LABEL } from "@/lib/ai/coach/tools/source-keys";

/**
 * v1.21.0 (C4 H1/H4) — metric → Coach scope + seed-question map.
 *
 * The Coach launch context can now carry a live `scope` (a
 * `CoachScopeSource` + window) and a `prefill` seed question into the
 * conversation. This module is the single place that resolves "the user
 * is looking at metric X" into "open the Coach narrowed to source X with
 * a data-aware opener."
 *
 * Two callers consume it:
 *   - `<SubPageShell>` registers the active metric's scope as the page's
 *     ambient scope so the global FAB opens contextual to that page
 *     (no per-metric header icon — CCH-04 stays intact).
 *   - the "Ask the Coach" affordance on insight/assessment cards passes
 *     an explicit scope so a card tap lands a pre-scoped conversation.
 *
 * v1.22 (W6) — seed questions are i18n KEYS (`insights.coach.seed.*`), not
 * hardcoded English: a German user was getting an English composer seed. The
 * consumer (`SubPageShell`) resolves the key through `t()` before handing it to
 * the composer, so the seed reads in the user's language.
 */

export interface CoachMetricScope {
  /** Primary source the snapshot narrows to. */
  metric: CoachScopeSource;
  /** Extra sources to include alongside `metric` (e.g. correlations). */
  also?: CoachScopeSource[];
  /** Optional day-window override; defaults to the route's `last30days`. */
  window?: CoachScopeWindow;
  /** i18n key for the composer seed question — resolved by the consumer. */
  question: string;
}

/**
 * `SubPageShell` passes the metric's `explainerMetric` token (the key
 * feeding `insights.subPage.explainer.<metric>Body`). Map the tokens that
 * resolve to a snapshot source to a scope + opener. Tokens absent here
 * (mobility / gait micro-metrics with no dedicated snapshot block) simply
 * carry no ambient scope — the FAB opens the default snapshot, exactly as
 * before, so this is purely additive.
 */
const EXPLAINER_METRIC_SCOPE: Record<string, CoachMetricScope> = {
  bloodPressure: {
    metric: "bp",
    question: "insights.coach.seed.bloodPressure",
  },
  weight: {
    metric: "weight",
    question: "insights.coach.seed.weight",
  },
  bmi: {
    metric: "bmi",
    question: "insights.coach.seed.bmi",
  },
  pulse: {
    metric: "pulse",
    question: "insights.coach.seed.pulse",
  },
  restingHr: {
    metric: "resting_hr",
    question: "insights.coach.seed.restingHr",
  },
  hrv: {
    metric: "hrv",
    question: "insights.coach.seed.hrv",
  },
  sleep: {
    metric: "sleep",
    question: "insights.coach.seed.sleep",
  },
  mood: {
    metric: "mood",
    question: "insights.coach.seed.mood",
  },
  medications: {
    metric: "compliance",
    question: "insights.coach.seed.medications",
  },
  steps: {
    metric: "steps",
    question: "insights.coach.seed.steps",
  },
  activeEnergy: {
    metric: "active_energy",
    question: "insights.coach.seed.activeEnergy",
  },
  cardioFitness: {
    metric: "vo2_max",
    question: "insights.coach.seed.cardioFitness",
  },
  bloodGlucose: {
    metric: "glucose",
    question: "insights.coach.seed.bloodGlucose",
  },
  oxygenSaturation: {
    metric: "spo2",
    question: "insights.coach.seed.oxygenSaturation",
  },
  respiratoryRate: {
    metric: "respiratory_rate",
    question: "insights.coach.seed.respiratoryRate",
  },
  workouts: {
    metric: "workouts",
    question: "insights.coach.seed.workouts",
  },
  // Recovery is a synthesis page; anchor on HRV + resting HR + sleep so the
  // Coach reads the inputs that drive the recovery read.
  recoveryPage: {
    metric: "hrv",
    also: ["resting_hr", "sleep"],
    window: "last7days",
    question: "insights.coach.seed.recoveryPage",
  },
};

/** Resolve a `SubPageShell` explainer token to a Coach scope, or null. */
export function metricScopeFromExplainer(
  explainerMetric: string | undefined,
): CoachMetricScope | null {
  if (!explainerMetric) return null;
  return EXPLAINER_METRIC_SCOPE[explainerMetric] ?? null;
}

/**
 * Resolve a recommendation / correlation `metricSource.type` — the
 * model's snapshot-key vocabulary ("bloodPressure", "weight", "pulse",
 * "mood", "medications.compliance30", "sleep", "steps", …) — to a single
 * `CoachScopeSource`, or null when the key has no snapshot block to
 * narrow to. Lets a card's "Ask the Coach" affordance pre-scope the
 * conversation to the metric the card is about.
 */
export function scopeSourceFromMetricKey(
  metricKey: string | undefined,
): CoachScopeSource | null {
  if (!metricKey) return null;
  const lower = metricKey.toLowerCase();
  if (lower.startsWith("medications.compliance") || lower === "medication") {
    return "compliance";
  }
  if (lower === "bloodpressure" || lower === "blood_pressure") return "bp";
  if (lower === "weight") return "weight";
  if (lower === "pulse") return "pulse";
  if (lower === "resting_hr" || lower === "restinghr") return "resting_hr";
  if (lower === "hrv") return "hrv";
  if (lower === "mood") return "mood";
  if (lower === "sleep" || lower.startsWith("sleep")) return "sleep";
  if (lower === "steps" || lower === "activity") return "steps";
  if (lower === "bloodglucose" || lower === "blood_glucose") return "glucose";
  if (lower === "bmi") return "bmi";
  return null;
}

/**
 * v1.21.2 (A2) — the human label for a launch scope's primary metric, for
 * the VISIBLE "the Coach is already on …" pill. The caller resolves the
 * i18n string via `t("insights.coach.scope.metric.<source>")`; this helper
 * supplies the English domain phrase as the deterministic fallback for any
 * source the bundle hasn't named yet, reusing the brand-free
 * `COACH_SOURCE_DOMAIN_LABEL` vocabulary the Coach inventory already
 * speaks. Returns null when there is no metric to label (a generic open).
 */
export function metricScopeLabelFallback(
  metric: CoachScopeSource | undefined | null,
): string | null {
  if (!metric) return null;
  return COACH_SOURCE_DOMAIN_LABEL[metric] ?? (metric as string);
}

/**
 * v1.21.2 (A2) — map a launch-scope source onto the EXISTING localised
 * `measurements.type*` metric-name key. The scope pill reads in the user's
 * own language for every measurement-backed source, instead of the English
 * `COACH_SOURCE_DOMAIN_LABEL` fallback that only carries the brand-free
 * domain phrase. Sources without a measurement name (mood, the gait / audio
 * long tail) keep that English fallback — they almost never become a scoped
 * launch. Returns the key, or null when the source has no localised name.
 */
const SCOPE_SOURCE_METRIC_LABEL_KEY: Partial<Record<CoachScopeSource, string>> =
  {
    bp: "measurements.typeBloodPressure",
    weight: "measurements.typeWeight",
    pulse: "measurements.typePulse",
    hrv: "measurements.typeHeartRateVariability",
    resting_hr: "measurements.typeRestingHeartRate",
    respiratory_rate: "measurements.typeRespiratoryRate",
    spo2: "measurements.typeOxygenSaturation",
    bmi: "measurements.typeBodyMassIndex",
    body_temp: "measurements.typeBodyTemperature",
    vo2_max: "measurements.typeVo2Max",
    sleep: "measurements.typeSleep",
    body_fat: "measurements.typeBodyFat",
    fat_mass: "measurements.typeFatMass",
    fat_free_mass: "measurements.typeFatFreeMass",
    muscle_mass: "measurements.typeMuscleMass",
    lean_body_mass: "measurements.typeLeanBodyMass",
    bone_mass: "measurements.typeBoneMass",
    active_energy: "measurements.typeActiveEnergyBurned",
    flights: "measurements.typeFlightsClimbed",
  };

export function scopeSourceMetricLabelKey(
  metric: CoachScopeSource | undefined | null,
): string | null {
  if (!metric) return null;
  return SCOPE_SOURCE_METRIC_LABEL_KEY[metric] ?? null;
}
