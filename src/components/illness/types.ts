/**
 * Client-side illness DTO mirrors (v1.18.1) — the wire shapes the
 * `/api/illness/*` routes return. Kept in lockstep with
 * `src/lib/illness/dto.ts` (the server-authoritative source).
 */
export type IllnessType =
  | "INFECTION"
  | "ALLERGY"
  | "INJURY"
  | "MENTAL_HEALTH"
  | "AUTOIMMUNE"
  | "CHRONIC"
  | "OTHER";

export type IllnessLifecycle =
  | "ACUTE"
  | "CHRONIC_ONGOING"
  | "RECURRING"
  | "FLARE";

export interface IllnessSymptomSelection {
  key: string;
  severity?: number | null;
}

export interface IllnessEpisodeDTO {
  id: string;
  label: string;
  type: IllnessType;
  lifecycle: IllnessLifecycle;
  onsetAt: string;
  resolvedAt: string | null;
  parentConditionId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IllnessDayLogDTO {
  id: string;
  episodeId: string;
  date: string;
  functionalImpact: number | null;
  feverC: number | null;
  symptoms: IllnessSymptomSelection[];
  note: string | null;
  updatedAt: string;
}

/**
 * v1.18.3 — the date-less day-log LIST response (`GET .../day-logs` with no
 * `date`). Server-authoritative; iOS (healthlog-iOS#30) renders the rows +
 * pages on `meta.total`. Mirrors the Labs list envelope shape.
 */
export interface IllnessDayLogListResponse {
  dayLogs: IllnessDayLogDTO[];
  meta: { total: number; limit: number; offset: number };
}

export interface IllnessEpisodeCreateInput {
  label: string;
  type: IllnessType;
  lifecycle?: IllnessLifecycle;
  onsetAt?: string;
  parentConditionId?: string | null;
  note?: string | null;
}

export interface IllnessDayLogInput {
  date: string;
  functionalImpact?: number | null;
  feverC?: number | null;
  symptoms?: IllnessSymptomSelection[];
  note?: string | null;
}

export interface IllnessEpisodeUpdateInput {
  label?: string;
  type?: IllnessType;
  lifecycle?: IllnessLifecycle;
  onsetAt?: string;
  resolvedAt?: string | null;
  parentConditionId?: string | null;
  note?: string | null;
}

/* ── P3 correlation + retrospective DTOs (server-authoritative) ───────── */

export interface IllnessVitalDeviation {
  type: string;
  day: string;
  value: number;
  baselineCenter: number;
  deviationSd: number;
  direction: "above" | "below";
  adverse: boolean;
}

export interface IllnessVitalReturn {
  /** A `MeasurementType`, or `"FUNCTIONAL_IMPACT"` for the symptom-burden track. */
  type: string;
  returnedDay: string | null;
  gapDays: number | null;
  adverse: boolean;
}

export interface IllnessRedFlag {
  type: string;
  reason: "sustained_low_spo2" | "sustained_fever";
  worstValue: number;
  days: number;
}

export interface IllnessCorrelationValue {
  episodeId: string;
  preOnset: IllnessVitalDeviation[];
  nadir: IllnessVitalDeviation[];
  returns: IllnessVitalReturn[];
  recoveryGapDays: number | null;
  adverseCoverageDays: number;
  feltBetterDay: string | null;
  /**
   * The metric that drove the headline gap — a `MeasurementType`,
   * `"FUNCTIONAL_IMPACT"` (the symptom-burden track), or null. Drives the
   * driver-aware recovery-gap copy.
   */
  gapDriverType: string | null;
  redFlags: IllnessRedFlag[];
}

/** The flat `Derived<T>` wire shape the correlation route returns. */
export interface IllnessCorrelationResponse {
  episodeId: string;
  status: "ok" | "insufficient";
  value: IllnessCorrelationValue | null;
  coverage: {
    requiredInputs: number;
    presentInputs: number;
    historyDays: number;
    missing: string[];
  };
  confidence: { score: number; band: string } | null;
  provenance: {
    inputs: string[];
    source: string;
    windowDays: number;
    computedAt: string;
  };
  reason: string | null;
}

export interface IllnessInsightsResponse {
  windowDays: number;
  episodeCount: number;
  resolvedCount: number;
  typicalRecoveryGapDays: number | null;
  gapSampleSize: number;
  byMonth: Record<string, number>;
  byType: Record<string, number>;
  gapDriverType: string | null;
}
