/**
 * v1.10.0 — the coverage / confidence model + the `Derived<T>` builders.
 *
 * `deriveCoverage` turns the raw "what does this metric want vs what is
 * present, and how much history backs it" facts into a `DerivedCoverage`
 * + a `DerivedConfidence` band. `buildOk` / `buildInsufficient` are the
 * two terminal constructors every pure compute function returns — they
 * attach coverage + confidence + provenance at compute time, inside the
 * pure function, so no surface ever has to bolt them on per-screen.
 *
 * Confidence model (carried from the metric catalogue, §2.1):
 *   - history scales the band width — < `minHistoryDays` nights → no band
 *     (the caller returns `insufficient`); 7d → low, 14d → medium,
 *     30d+ → high.
 *   - for composites, the present/required input ratio drops the score
 *     monotonically as `missing` grows.
 * Confidence is a blend of the history fraction and the input-presence
 * fraction so that a fully-covered short-history metric and a
 * long-history partially-covered composite both land honestly.
 *
 * Client-safe — pure functions, no server imports.
 */
import type {
  Derived,
  DerivedConfidence,
  DerivedConfidenceBand,
  DerivedCoverage,
  DerivedProvenance,
} from "./types";

/** Clamp helper. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Map a 0..100 score onto the confidence band the shared meter renders.
 * `draft` is reserved for a value computed below its minimum-history
 * floor but still surfaced (value-only, no band) — callers that gate
 * hard return `insufficient` instead and never reach this.
 */
export function scoreToBand(score: number): DerivedConfidenceBand {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  if (score >= 25) return "low";
  return "draft";
}

export interface DeriveCoverageArgs {
  /** Inputs the metric wants (its full input set; ≥ 1). */
  requiredInputs: number;
  /** Inputs actually present. */
  presentInputs: number;
  /** Days of history backing the value. */
  historyDays: number;
  /** Named inputs still missing. */
  missing: string[];
  /**
   * History-day count at which the band reaches full width / full
   * history confidence. Defaults to 30 (the typical-range engine's
   * 30-day window); composites pass their own.
   */
  fullHistoryDays?: number;
}

/**
 * Build the `DerivedCoverage` + `DerivedConfidence` pair from the raw
 * coverage facts. Confidence = the product of the history fraction
 * (capped at `fullHistoryDays`) and the input-presence fraction, scaled
 * to 0..100 and floored so a present-but-sparse value never reports 0.
 */
export function deriveCoverage(args: DeriveCoverageArgs): {
  coverage: DerivedCoverage;
  confidence: DerivedConfidence;
} {
  const requiredInputs = Math.max(1, args.requiredInputs);
  const presentInputs = clamp(args.presentInputs, 0, requiredInputs);
  const historyDays = Math.max(0, args.historyDays);
  const fullHistoryDays = Math.max(1, args.fullHistoryDays ?? 30);

  const historyFraction = clamp(historyDays / fullHistoryDays, 0, 1);
  const inputFraction = presentInputs / requiredInputs;

  // Geometric-ish blend: both axes must be healthy for a high score, but
  // a fully-covered short-history metric still earns a non-trivial score
  // and a long-history partially-covered composite is penalised by its
  // missing inputs. Floor at 1 so a real (non-insufficient) value never
  // reads as 0 confidence.
  const rawScore = historyFraction * inputFraction * 100;
  const score = presentInputs > 0 && historyDays > 0
    ? Math.round(clamp(rawScore, 1, 100))
    : 0;

  return {
    coverage: {
      requiredInputs,
      presentInputs,
      historyDays,
      missing: [...args.missing],
    },
    confidence: { score, band: scoreToBand(score) },
  };
}

/**
 * Terminal constructor — a successful derived value. Attaches coverage +
 * confidence + provenance computed by the caller (via `deriveCoverage`).
 */
export function buildOk<T>(args: {
  value: T;
  coverage: DerivedCoverage;
  confidence: DerivedConfidence;
  provenance: DerivedProvenance;
}): Derived<T> {
  return {
    status: "ok",
    value: args.value,
    coverage: args.coverage,
    confidence: args.confidence,
    provenance: args.provenance,
  };
}

/**
 * Terminal constructor — a gated derived value. Carries coverage +
 * provenance so the surface renders the shared "track N more days" state.
 */
export function buildInsufficient<T>(args: {
  coverage: DerivedCoverage;
  provenance: DerivedProvenance;
  reason: string;
}): Derived<T> {
  return {
    status: "insufficient",
    coverage: args.coverage,
    provenance: args.provenance,
    reason: args.reason,
  };
}

/** ISO 8601 timestamp with offset — the provenance `computedAt` source. */
export function nowProvenanceTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}
