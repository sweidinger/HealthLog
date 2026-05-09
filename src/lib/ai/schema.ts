import { z } from "zod/v4";

/**
 * Strict response schema for v1.4.15 AI hardening (Phase C1).
 *
 * Marc, verbatim 2026-05-09: "Es darf null Halluzinationen haben und es
 * muss sich halt irgendwie stützen auf medizinische Dinge."  ("It must
 * have zero hallucinations and must ground on medical facts.")
 *
 * The schema enforces:
 *   - A short natural-language summary.
 *   - A typed `recommendations[]` where each item is structured
 *     (`id`, `text`, `severity`) and MUST cite the user-data point that
 *     justified it via `metricSource`. An empty `metricSource.summary`
 *     fails parse — the model cannot fabricate recommendations without
 *     pointing to a number from the user's snapshot.
 *   - A `citations[]` array referencing the metrics the response drew
 *     on. May be empty when `recommendations[]` is empty (no data → no
 *     citation), but every recommendation's `metricSource` MUST also
 *     appear in `citations[]` (cross-check enforced by `validateInsightResponse`).
 *   - A `warnings[]` array for guideline-flagged values (high BP,
 *     critical pulse, etc.). Free-form for now; v1.4.16 adds severity
 *     enum + medical-reference grounding.
 *
 * Legacy rich fields (`classification`, `findings`, `correlations`,
 * `dataQuality`, `disclaimer`) remain accepted via `.passthrough()` so
 * cached payloads from v1.4.14 still hydrate the dashboard. The
 * v1.4.16 roadmap (`docs/audit/v1416-ai-roadmap.md`) plans the full
 * migration to the strict shape once all consumers move over.
 */

// Severity levels — generic for v1.4.15. v1.4.16 adds a clinical
// severity enum keyed to ESH/ESC and AHA guidelines.
export const recommendationSeveritySchema = z.enum([
  "info",
  "suggestion",
  "important",
  "urgent",
]);

/**
 * Citation-from-data: every recommendation must point to a concrete
 * snapshot field that justified it. Empty `summary` is rejected.
 */
export const metricSourceSchema = z.object({
  /**
   * Snapshot key — e.g. "bloodPressure", "weight", "pulse",
   * "medications.compliance30". Free-form because the snapshot shape
   * itself is rich; v1.4.16 narrows to a typed enum.
   */
  type: z.string().min(1, "metricSource.type required"),
  /**
   * Time window the value covers — e.g. "last7days", "last30days",
   * "allTime". v1.4.16 narrows this enum.
   */
  timeRange: z.string().min(1, "metricSource.timeRange required"),
  /**
   * Human-readable summary of the data point — e.g. "avg 142/88 over
   * 12 readings" or "compliance 0.71 / 30d". Empty value rejected so
   * the model cannot fake a citation.
   */
  summary: z
    .string()
    .min(1, "metricSource.summary required (zero-hallucination)"),
  /** Sample count behind the value, when known. */
  n: z.number().int().nonnegative().optional(),
});

export type MetricSource = z.infer<typeof metricSourceSchema>;

export const aiRecommendationSchema = z.object({
  /**
   * Stable identifier for the recommendation within this response.
   * Used by the future user-feedback loop ("was this helpful?",
   * v1.4.16 roadmap). Format: short slug (`rec-1`, `bp-elevated`).
   */
  id: z.string().min(1, "recommendation.id required"),
  /** Human-readable recommendation text. */
  text: z.string().min(1, "recommendation.text required"),
  /**
   * Mandatory citation — the data point that justified the
   * recommendation. Closes the "ungrounded boilerplate" risk Marc
   * called out: every recommendation must trace back to user data.
   */
  metricSource: metricSourceSchema,
  /** Severity — generic for v1.4.15, clinically-keyed in v1.4.16. */
  severity: recommendationSeveritySchema,
});

export type AIRecommendation = z.infer<typeof aiRecommendationSchema>;

export const aiCitationSchema = z.object({
  /** Snapshot key being cited. */
  type: z.string().min(1, "citation.type required"),
  /** Window of the value. */
  timeRange: z.string().min(1, "citation.timeRange required"),
  /** Short description of the data point. */
  summary: z.string().min(1, "citation.summary required"),
});

export type AICitation = z.infer<typeof aiCitationSchema>;

export const aiWarningSchema = z.object({
  /** Topic — "blood_pressure", "pulse", etc. */
  topic: z.string().min(1, "warning.topic required"),
  /** What's flagged. */
  message: z.string().min(1, "warning.message required"),
  /** Severity tag for downstream filtering. */
  severity: recommendationSeveritySchema.optional(),
});

export type AIWarning = z.infer<typeof aiWarningSchema>;

/**
 * Canonical strict response schema. New strict fields are required;
 * legacy rich fields ride along through `.passthrough()` for back-
 * compat with cached payloads and the existing dashboard renderer.
 */
export const aiInsightResponseSchema = z
  .object({
    /** 2-3 sentence overall summary in user-facing locale. */
    summary: z.string().min(1, "summary required"),
    /** Structured recommendations with mandatory citations. */
    recommendations: z.array(aiRecommendationSchema),
    /** Citations supporting any claim in summary or recommendations. */
    citations: z.array(aiCitationSchema),
    /** Guideline-flagged values (e.g. BP > 140/90). May be empty. */
    warnings: z.array(aiWarningSchema),
  })
  .passthrough();

export type AIInsightResponse = z.infer<typeof aiInsightResponseSchema>;

/**
 * Tagged error thrown by the schema-enforcement wrapper when even the
 * retry attempt fails to produce a valid payload. The route catches
 * this and surfaces a 422 to the client.
 */
export class InsightSchemaError extends Error {
  readonly httpStatus = 422;
  readonly issues: z.ZodIssue[] | null;
  readonly attempts: number;

  constructor(
    message: string,
    options: { issues?: z.ZodIssue[]; attempts: number },
  ) {
    super(message);
    this.name = "InsightSchemaError";
    this.issues = options.issues ?? null;
    this.attempts = options.attempts;
  }
}

/**
 * Cross-validation beyond zod: every recommendation's `metricSource`
 * must also appear in `citations[]` (same `type` + `timeRange`).
 * Returns the list of missing-citation issues; an empty list means
 * the response is internally consistent.
 */
export function findUncitedRecommendations(parsed: AIInsightResponse): Array<{
  recommendationId: string;
  missing: { type: string; timeRange: string };
}> {
  const cited = new Set(
    parsed.citations.map((c) => `${c.type}::${c.timeRange}`),
  );
  const missing: Array<{
    recommendationId: string;
    missing: { type: string; timeRange: string };
  }> = [];
  for (const rec of parsed.recommendations) {
    const key = `${rec.metricSource.type}::${rec.metricSource.timeRange}`;
    if (!cited.has(key)) {
      missing.push({
        recommendationId: rec.id,
        missing: {
          type: rec.metricSource.type,
          timeRange: rec.metricSource.timeRange,
        },
      });
    }
  }
  return missing;
}
