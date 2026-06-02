/**
 * v1.10.0 — public barrel for the derived-metrics layer.
 *
 * The one module every consumer imports from. Append-only per wave —
 * Wave 1 exports the foundation (`Derived<T>` + coverage builders +
 * registry + norms + the flagship baseline engine + the route
 * dispatcher); W2/W3 append their per-metric engines (`fitness-age`,
 * `vascular-age`, `sleep-score`, `readiness`) here.
 *
 * Re-exports the client-safe types/coverage builders and the
 * server-only compute engines from one place; consumers import only what
 * they need. (A `"use client"` component must value-import only from
 * `./types` + `./coverage` + `./registry` — those are server-import-free.
 * The route + server consumers may import the engines below.)
 */

// ── client-safe contract (types + pure builders + metadata) ──────────
export type {
  Derived,
  DerivedOk,
  DerivedInsufficient,
  DerivedCoverage,
  DerivedConfidence,
  DerivedConfidenceBand,
  DerivedProvenance,
  DerivedProvenanceSource,
} from "./types";
export { isDerivedOk } from "./types";

export {
  deriveCoverage,
  buildOk,
  buildInsufficient,
  scoreToBand,
  nowProvenanceTimestamp,
} from "./coverage";
export type { DeriveCoverageArgs } from "./coverage";

export {
  DERIVED_METRIC_IDS,
  VITALS_BASELINE_TYPES,
  isDerivedMetricId,
  getDerivedMetricMeta,
  isVitalsBaselineType,
} from "./registry";
export type {
  DerivedMetricId,
  DerivedMetricMeta,
  DerivedArchetype,
} from "./registry";

export { lookupNormalRange, hasSharpenedNorm } from "./norms";
export type { NormRange, NormSex } from "./norms";

// ── server-only compute engines (do NOT value-import from a client component) ──
export {
  computeVitalsBaseline,
  buildBaselineBand,
  median,
  medianAbsoluteDeviation,
} from "./baseline";
export type {
  VitalsBaselineValue,
  VitalsBaselineOpts,
  BaselineProfile,
} from "./baseline";

export { computeDerivedMetric } from "./dispatch";
export type { DerivedComputeArgs } from "./dispatch";
