/**
 * The corrective retry prompt for a structured-output generation that came
 * back malformed.
 *
 * History worth keeping, because the shape of this module is a consequence of
 * it: this file used to hold `generateInsight()`, a schema-enforced wrapper
 * that parsed a reply against the strict `aiInsightResponseSchema`,
 * cross-checked that every recommendation's `metricSource` appeared in
 * `citations[]`, retried once with the message below, and threw
 * `InsightSchemaError` on a second failure. That wrapper's only caller was
 * `runWithFallback()`, which itself had no production caller — every live
 * surface runs `runRawCompletionWithFallback` and validates with its own
 * schema. So the enforcement never executed. It was removed rather than wired
 * in: the live `insightResultSchema` has no `citations[]` field at all and
 * treats `metricSource` as optional, so applying the strict cross-check to a
 * live payload would have rejected essentially every generation.
 *
 * What survived is the part that was always reachable — the corrective
 * message, which `comprehensive-generate.ts` sends on its own JSON-retry leg.
 * The message kept describing the DEAD wrapper's contract long after the
 * wrapper went: it demanded `citations[]` and `warnings[]` (fields the live
 * `insightResultSchema` does not have), demanded `id` / `severity` /
 * `metricSource` / `rationale` on every recommendation (all optional in the
 * live schema), and named NONE of the five fields the live schema actually
 * requires — `classification`, `findings`, `correlations`, `dataQuality`,
 * `disclaimer`. So the one corrective pass steered the model away from the
 * contract it was being corrected towards: the retry reply could not validate,
 * fell through `parseComprehensiveResult`'s raw-object escape hatch, and the
 * downstream surfaces read an unvalidated payload.
 *
 * The message below now describes `insightResultSchema` (`src/lib/ai/types.ts`)
 * and nothing else. `RETRY_CONTRACT_EXAMPLE` is the same contract as data, and
 * a test validates it against the schema — so the prompt and the validator
 * cannot drift apart again without the suite going red.
 */

/**
 * A minimal payload that satisfies `insightResultSchema` exactly: every
 * required field present, no optional field set. Embedded verbatim in the
 * corrective message so the model has an unambiguous target, and asserted
 * against the schema in `__tests__/retry-correction.test.ts`.
 */
export const RETRY_CONTRACT_EXAMPLE = {
  summary: "Two to three sentences describing the period.",
  classification: "gut",
  findings: [
    { label: "Metric name", value: "Value as text", assessment: "neutral" },
  ],
  correlations: [
    { factor: "Factor name", effect: "Observed effect", confidence: "mittel" },
  ],
  recommendations: [{ text: "One grounded, actionable sentence." }],
  dataQuality: {
    coverage: "How much of the window carried readings.",
    gaps: ["A named gap, or an empty array."],
    confidence: "mittel",
  },
  disclaimer: "The standard non-diagnostic disclaimer.",
} as const;

/**
 * Build the corrective user-prompt suffix that explains to the model
 * what went wrong on the first attempt. Includes the violated zod
 * issues verbatim (truncated to 1KB) so the model can self-correct.
 */
export function buildRetryCorrectionMessage(
  reason: string,
  details: string,
): string {
  return `
Your previous response did not satisfy the required JSON schema.
Reason: ${reason}
Details: ${details.slice(0, 1024)}

You MUST return a single JSON object. Do NOT include prose, markdown
fences, or commentary outside the JSON.

Required top-level fields — all seven MUST be present:
  - summary: string (2-3 sentences)
  - classification: exactly one of "optimal" | "gut" | "grenzwertig"
      | "erhoht" | "kritisch"
  - findings: array of { label: string, value: string,
      assessment: "positive" | "neutral" | "attention" | "warning" }
  - correlations: array of { factor: string, effect: string,
      confidence: "hoch" | "mittel" | "gering" }
  - recommendations: array of { text: string }
  - dataQuality: { coverage: string, gaps: array of string,
      confidence: "hoch" | "mittel" | "gering" }
  - disclaimer: string

An empty array is acceptable for findings, correlations, and
recommendations. If you cannot ground a recommendation in the user
data from the snapshot you were given, OMIT that recommendation.

A recommendation object MAY additionally carry any of: id, severity
("info" | "suggestion" | "important" | "urgent"), metricSource
({ type, timeRange, summary }), rationale ({ dataWindow, comparedTo,
deviation }), confidence (integer 0-100). All of these are OPTIONAL —
omit any you cannot ground rather than inventing a value. Do NOT add
top-level fields beyond the seven listed above.

A minimal valid response looks exactly like this:
${JSON.stringify(RETRY_CONTRACT_EXAMPLE, null, 2)}
`;
}
