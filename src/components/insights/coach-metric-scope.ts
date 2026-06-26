import type { CoachScopeSource, CoachScopeWindow } from "@/lib/ai/coach/types";

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
 * Seed questions are plain English strings, mirroring the empty-state
 * `coachPrefill` convention already in the tree — the Coach chat route
 * is English/German-gated and treats the prefill as composer seed text,
 * not an i18n key.
 */

export interface CoachMetricScope {
  /** Primary source the snapshot narrows to. */
  metric: CoachScopeSource;
  /** Extra sources to include alongside `metric` (e.g. correlations). */
  also?: CoachScopeSource[];
  /** Optional day-window override; defaults to the route's `last30days`. */
  window?: CoachScopeWindow;
  /** Composer seed question — a data-aware opener for the metric. */
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
    question:
      "Walk me through my blood pressure trend over the last 30 days — anything I should keep an eye on?",
  },
  weight: {
    metric: "weight",
    question:
      "How has my weight been trending lately, and is the direction something to act on?",
  },
  bmi: {
    metric: "bmi",
    question: "What does my BMI trend tell me, and how should I read it?",
  },
  pulse: {
    metric: "pulse",
    question:
      "Walk me through my pulse readings — is anything out of the ordinary?",
  },
  restingHr: {
    metric: "resting_hr",
    question:
      "How has my resting heart rate been trending, and what does it say about my fitness?",
  },
  hrv: {
    metric: "hrv",
    question:
      "What is my heart-rate variability telling me about recovery and stress lately?",
  },
  sleep: {
    metric: "sleep",
    question:
      "Walk me through my recent sleep — duration, consistency, and anything worth changing.",
  },
  mood: {
    metric: "mood",
    question: "What patterns do you see in my mood over the last few weeks?",
  },
  medications: {
    metric: "compliance",
    question:
      "How is my medication adherence looking, and is it lined up with how I've been feeling?",
  },
  steps: {
    metric: "steps",
    question:
      "How active have I been lately based on my steps, and how does it compare to a healthy baseline?",
  },
  activeEnergy: {
    metric: "active_energy",
    question:
      "What does my active-energy trend say about my activity level lately?",
  },
  cardioFitness: {
    metric: "vo2_max",
    question:
      "What does my cardio fitness (VO₂ max) trend mean, and how do I move it in the right direction?",
  },
  bloodGlucose: {
    metric: "glucose",
    question:
      "Walk me through my recent glucose readings — are they in a healthy range?",
  },
  oxygenSaturation: {
    metric: "spo2",
    question: "What does my blood-oxygen (SpO₂) trend tell me?",
  },
  respiratoryRate: {
    metric: "respiratory_rate",
    question: "What does my respiratory-rate trend say about my health?",
  },
  workouts: {
    metric: "workouts",
    question:
      "Walk me through my recent workouts — load, frequency, and how I'm recovering between them.",
  },
  // Recovery is a synthesis page; anchor on HRV + resting HR + sleep so the
  // Coach reads the inputs that drive the recovery read.
  recoveryPage: {
    metric: "hrv",
    also: ["resting_hr", "sleep"],
    window: "last7days",
    question:
      "Why is my recovery where it is right now, and what's driving it?",
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
