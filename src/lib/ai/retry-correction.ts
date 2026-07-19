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
 */

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

You MUST return a JSON object matching this schema exactly. Do NOT
include prose, markdown fences, or commentary outside the JSON.

Required top-level fields:
  - summary: string (2-3 sentences)
  - recommendations: array of objects with
      { id: string,
        text: string,
        severity: "info" | "suggestion" | "important" | "urgent",
        metricSource: { type: string, timeRange: string, summary: string, n?: number },
        rationale: { dataWindow: "last7days" | "last30days" | "last90days" | "allTime",
                     comparedTo: non-empty string,
                     deviation: non-empty string } }
  - citations: array of objects with { type: string, timeRange: string, summary: string }
  - warnings: array of objects with { topic: string, message: string, severity?: same enum }

Every recommendation's metricSource MUST also appear in citations[]
(same type + timeRange). Every recommendation MUST carry a
rationale object — dataWindow, comparedTo, and deviation are all
required and rationale.dataWindow MUST equal metricSource.timeRange.
If you cannot ground a recommendation in user data from the
snapshot you were given, OMIT it. An empty recommendations[] is
acceptable.
`;
}
