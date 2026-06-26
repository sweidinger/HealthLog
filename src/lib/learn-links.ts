/**
 * v1.21.0 — typed Learn-article link registry for deterministic UI surfaces.
 *
 * The public /learn guides are the secondary, plain-language education layer
 * (the primary-source guideline/study citations live separately in
 * `medical-citations.ts`). The Coach already references the guides through its
 * static catalog (`src/lib/ai/coach/learn-catalog.ts`); this module promotes
 * that same catalog into a typed `concept → guide` lookup the React surfaces
 * can consume.
 *
 * Single source of truth: the slug list is NOT duplicated here — every URL is
 * minted from a `LEARN_GUIDES` entry via `learnUrl(slug)`, which is the ONLY
 * sanctioned way to build a /learn URL outside the catalog itself. A concept
 * with no mapped guide returns `null` (fail-closed) so a surface never renders
 * an invented href.
 */

import { LEARN_GUIDES, type LearnGuide } from "@/lib/ai/coach/learn-catalog";

/** Fast slug → guide index over the published catalog. */
const GUIDE_BY_SLUG: ReadonlyMap<string, LearnGuide> = new Map(
  LEARN_GUIDES.map((g) => [g.slug, g]),
);

/**
 * The catalog slugs, narrowed to a literal union so a typo in `LEARN_LINKS`
 * is a compile error rather than a dead link. Mirrors the 19 published guides.
 */
export type LearnSlug =
  | "understanding-your-health-metrics"
  | "resting-heart-rate"
  | "heart-rate-variability"
  | "reading-your-blood-pressure"
  | "sleep-consistency"
  | "respiratory-rate"
  | "blood-oxygen-spo2"
  | "body-temperature-baseline"
  | "blood-sugar-beyond-diabetes"
  | "vo2max-and-longevity"
  | "beyond-the-scale"
  | "tracking-mood"
  | "the-cycle-as-a-vital-sign"
  | "how-wearables-measure-you"
  | "reading-your-trends"
  | "steps-and-movement"
  | "caffeine-alcohol-and-your-readings"
  | "hydration-and-your-body"
  | "stress-and-recovery";

/**
 * Stable concept keys the UI maps to a guide. The metric-shaped keys reuse the
 * app's own `InsightMetric` identifiers verbatim (so a vitals tile / metric
 * page passes its metric id straight through); the remaining keys name a
 * cross-cutting concept (a composite score, a trend explainer, the generic
 * lab biomarker fallback).
 */
export type LearnConcept =
  // metric-shaped (subset of InsightMetric ids that have a matching guide)
  | "RESTING_HEART_RATE"
  | "HEART_RATE_VARIABILITY"
  | "HRV_RMSSD"
  | "BLOOD_PRESSURE_SYS"
  | "BLOOD_PRESSURE_DIA"
  | "OXYGEN_SATURATION"
  | "RESPIRATORY_RATE"
  | "BODY_TEMPERATURE"
  | "SKIN_TEMPERATURE"
  | "BLOOD_GLUCOSE"
  | "VO2_MAX"
  | "WEIGHT"
  | "BMI"
  | "MOOD"
  | "STEPS"
  | "ACTIVITY_STEPS"
  // concept-shaped (no single metric id)
  | "HEALTH_METRICS_OVERVIEW"
  | "TRENDS"
  | "RESILIENCE"
  | "SLEEP_CONSISTENCY"
  | "CYCLE"
  | "WEARABLES"
  | "LAB_BIOMARKER";

/**
 * The frozen `concept → slug` mapping. Slugs are typed against `LearnSlug`, and
 * a unit test asserts each one resolves in `LEARN_GUIDES` — so the mapping can
 * never point at a guide that does not exist.
 */
export const LEARN_LINKS: Readonly<Record<LearnConcept, LearnSlug>> =
  Object.freeze({
    RESTING_HEART_RATE: "resting-heart-rate",
    HEART_RATE_VARIABILITY: "heart-rate-variability",
    HRV_RMSSD: "heart-rate-variability",
    BLOOD_PRESSURE_SYS: "reading-your-blood-pressure",
    BLOOD_PRESSURE_DIA: "reading-your-blood-pressure",
    OXYGEN_SATURATION: "blood-oxygen-spo2",
    RESPIRATORY_RATE: "respiratory-rate",
    BODY_TEMPERATURE: "body-temperature-baseline",
    SKIN_TEMPERATURE: "body-temperature-baseline",
    BLOOD_GLUCOSE: "blood-sugar-beyond-diabetes",
    VO2_MAX: "vo2max-and-longevity",
    WEIGHT: "beyond-the-scale",
    BMI: "beyond-the-scale",
    MOOD: "tracking-mood",
    STEPS: "steps-and-movement",
    ACTIVITY_STEPS: "steps-and-movement",
    HEALTH_METRICS_OVERVIEW: "understanding-your-health-metrics",
    TRENDS: "reading-your-trends",
    RESILIENCE: "stress-and-recovery",
    SLEEP_CONSISTENCY: "sleep-consistency",
    CYCLE: "the-cycle-as-a-vital-sign",
    WEARABLES: "how-wearables-measure-you",
    LAB_BIOMARKER: "understanding-your-health-metrics",
  });

/**
 * The ONLY sanctioned /learn URL builder. Resolves a catalog slug to its
 * absolute public URL; returns `null` for an unknown slug (fail-closed). No
 * other file should string-concatenate a /learn URL.
 */
export function learnUrl(slug: string): string | null {
  return GUIDE_BY_SLUG.get(slug)?.url ?? null;
}

/**
 * Resolve a concept key to its guide, or `null` when the concept is unmapped
 * or — defensively — its slug is missing from the catalog. A surface passes
 * the result straight to `<LearnMoreLink>`, which renders nothing on `null`.
 */
export function learnLinkForMetric(metricId: string): LearnGuide | null {
  const slug = (LEARN_LINKS as Record<string, LearnSlug | undefined>)[metricId];
  if (slug == null) return null;
  return GUIDE_BY_SLUG.get(slug) ?? null;
}
