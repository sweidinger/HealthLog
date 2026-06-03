/**
 * v1.10.0 — the `Derived<T>` discriminated union + its companion value
 * shapes (coverage / confidence / provenance).
 *
 * This is the one consumption contract for the derived-metrics layer:
 * every pure compute function returns `Derived<T>` and every surface
 * (dashboard tile, Insights card, Coach snapshot, daily briefing,
 * doctor/FHIR report, the native iOS client) pattern-matches `status`
 * rather than recomputing. The `ok` arm carries value + coverage +
 * confidence + provenance; the `insufficient` arm still carries coverage
 * + provenance so a surface renders the same gating UI ("track N more
 * days") instead of a blank.
 *
 * Client-safe by construction — pure types + tiny pure builders, no
 * server imports — so a `"use client"` component can value-import this
 * module without dragging the route/lib server graph into the bundle
 * (the v1.9.0 lesson). The compute functions live in server-only
 * siblings (`baseline.ts`, …) and import these types only.
 */

/** Confidence band rendered by the shared coverage meter. */
export type DerivedConfidenceBand = "high" | "medium" | "low" | "draft";

/**
 * The granularity the dominant read resolved against — mirrors the
 * rollup/live-SQL provenance the graded-series + dashboard-snapshot reads
 * already expose. `"live"` = a coverage-miss live-SQL fallback; `"none"`
 * = no data backed the value.
 */
export type DerivedProvenanceSource =
  | "DAY"
  | "WEEK"
  | "MONTH"
  | "YEAR"
  | "live"
  | "none";

/**
 * Where a derived value's inputs came from. Lets every surface show the
 * same "from your last 30 days, DAY buckets" chip.
 */
export interface DerivedProvenance {
  /** Named inputs that actually backed the value (e.g. ["RESTING_HEART_RATE"]). */
  inputs: string[];
  /** Granularity the dominant read resolved against. */
  source: DerivedProvenanceSource;
  /** Trailing window the value summarises, in days (e.g. 30 for a 30-day baseline). */
  windowDays: number;
  /** Compute time, for cache-staleness + the "as of" chip (ISO 8601, offset). */
  computedAt: string;
}

export interface DerivedCoverage {
  /** Inputs the metric WANTS (its full input set). */
  requiredInputs: number;
  /** Inputs actually present. */
  presentInputs: number;
  /** Days of history backing the value — the gating floor (< minHistoryDays → no band). */
  historyDays: number;
  /** Named inputs still missing — drives the "track BP/HRV to sharpen this" nudge. */
  missing: string[];
}

export interface DerivedConfidence {
  /** 0..100 — feeds the existing ConfidenceMeter component unchanged. */
  score: number;
  band: DerivedConfidenceBand;
}

/**
 * The successful arm: every successful value carries all four facets.
 */
export interface DerivedOk<T> {
  status: "ok";
  value: T;
  coverage: DerivedCoverage;
  confidence: DerivedConfidence;
  provenance: DerivedProvenance;
}

/**
 * The gated arm: no value, but coverage + provenance so the surface
 * renders the same "track N more days" state rather than a blank.
 */
export interface DerivedInsufficient {
  status: "insufficient";
  coverage: DerivedCoverage;
  provenance: DerivedProvenance;
  /** Why the value could not be produced (single short reason string). */
  reason: string;
}

/**
 * Cap for a trailing `series` carried on a `Derived<T>` value — the inline
 * sparkline a tile renders. The window readers already bound their reads;
 * this caps the points handed to the chart so a dense window never ships a
 * thousand-point array to the client. The tile only needs the recent shape.
 */
export const SPARKLINE_MAX_POINTS = 30;

export type Derived<T> = DerivedOk<T> | DerivedInsufficient;

/** Narrowing type guard — `true` when the value computed successfully. */
export function isDerivedOk<T>(d: Derived<T>): d is DerivedOk<T> {
  return d.status === "ok";
}
