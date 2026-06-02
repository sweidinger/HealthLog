/**
 * v1.10.0 — the derived-metrics design-system primitives barrel.
 *
 * Four reusable, presentational components that extend the existing token +
 * sentiment vocabulary; none introduce a new colour system. Reused across
 * the dashboard, Insights pages, the Coach / briefing and the doctor/FHIR
 * report. See `.planning/v1.10-build/design-sota-and-direction.md`.
 */

export { ScoreRing, type ScoreRingProps } from "./score-ring";
export { CoverageMeter, type CoverageMeterProps } from "./coverage-meter";
export {
  SparklineDeltaTile,
  type SparklineDeltaTileProps,
} from "./sparkline-delta-tile";
export {
  ProvenanceExplainer,
  type ProvenanceExplainerProps,
  type ProvenanceStandard,
} from "./provenance-explainer";
export {
  bandForScore,
  clampScore,
  BAND_NUMBER_CLASS,
  BAND_PROGRESS_CLASS,
  BAND_BORDER_CLASS,
  BAND_VAR,
  type ScoreBand,
} from "./band-tokens";

// ── W2b vitals dashboard surface + query hook ────────────────────────
export { VitalsDashboard } from "./vitals-dashboard";
export {
  useDerivedMetric,
  type DerivedMetricResponse,
  type UseDerivedMetricOptions,
} from "./use-derived-metric";
