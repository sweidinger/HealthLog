import type { z } from "zod/v4";
import type { AIProvider, CompletionParams, CompletionResult } from "./types";
import {
  aiInsightResponseSchema,
  findUncitedRecommendations,
  InsightSchemaError,
  type AIInsightResponse,
} from "./schema";

/**
 * Schema-enforced wrapper around `AIProvider.generateCompletion()`.
 *
 * Phase C1 (v1.4.15): Marc's mandate ("zero hallucinations, must
 * ground on user data") means a free-form LLM response is no longer
 * acceptable. This wrapper:
 *
 *   1. Calls the provider once.
 *   2. Parses the response as JSON.
 *   3. Validates it against `aiInsightResponseSchema` AND cross-checks
 *      that every recommendation's `metricSource` appears in
 *      `citations[]`.
 *   4. On failure: retries ONCE, prepending a corrective system
 *      message that includes the violated zod issues.
 *   5. On second failure: throws `InsightSchemaError` (httpStatus 422).
 *
 * The wrapper does not concern itself with provider-level retries
 * (HTTP 5xx, 401 token-refresh, etc.) — each provider client handles
 * those internally. This wrapper retries only on schema-violation.
 */

export interface GenerateInsightOutcome {
  parsed: AIInsightResponse;
  raw: CompletionResult;
  /** Number of provider calls made (1 on success, 2 on retry). */
  attempts: number;
  /** True iff the retry attempt produced the parsed response. */
  retried: boolean;
}

/**
 * Build the corrective user-prompt suffix that explains to the model
 * what went wrong on the first attempt. Includes the violated zod
 * issues verbatim (truncated to 1KB) so the model can self-correct.
 */
function buildRetryCorrectionMessage(reason: string, details: string): string {
  return `
Your previous response did not satisfy the required JSON schema.
Reason: ${reason}
Details: ${details.slice(0, 1024)}

You MUST return a JSON object matching this schema exactly. Do NOT
include prose, markdown fences, or commentary outside the JSON.

Required top-level fields:
  - summary: string (2-3 sentences)
  - recommendations: array of objects with
      { id: string, text: string, severity: "info" | "suggestion" | "important" | "urgent",
        metricSource: { type: string, timeRange: string, summary: string, n?: number } }
  - citations: array of objects with { type: string, timeRange: string, summary: string }
  - warnings: array of objects with { topic: string, message: string, severity?: same enum }

Every recommendation's metricSource MUST also appear in citations[]
(same type + timeRange). If you cannot ground a recommendation in
user data from the snapshot you were given, OMIT it. An empty
recommendations[] is acceptable.
`;
}

interface TryOutcome {
  ok: boolean;
  parsed?: AIInsightResponse;
  raw: CompletionResult;
  reason?: string;
  details?: string;
  zodIssues?: z.ZodIssue[];
}

async function tryOnce(
  provider: AIProvider,
  params: CompletionParams,
): Promise<TryOutcome> {
  const raw = await provider.generateCompletion(params);

  // Parse JSON.
  let json: unknown;
  try {
    json = JSON.parse(raw.content);
  } catch (e) {
    return {
      ok: false,
      raw,
      reason: "Response was not valid JSON",
      details: (e as Error).message,
    };
  }

  // Schema validate.
  const result = aiInsightResponseSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      raw,
      reason: "Response did not match the required JSON schema",
      details: result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
      zodIssues: result.error.issues,
    };
  }

  // Cross-check citations.
  const uncited = findUncitedRecommendations(result.data);
  if (uncited.length > 0) {
    const list = uncited
      .slice(0, 4)
      .map(
        (u) =>
          `${u.recommendationId} → ${u.missing.type}/${u.missing.timeRange}`,
      )
      .join(", ");
    return {
      ok: false,
      raw,
      reason: "Recommendations referenced metricSources not in citations[]",
      details: `Missing citations: ${list}`,
    };
  }

  return { ok: true, parsed: result.data, raw };
}

/**
 * Run a schema-enforced insight generation. Up to 2 provider calls.
 * Throws `InsightSchemaError` (httpStatus 422) if both attempts fail
 * the schema; provider-level errors bubble untouched.
 */
export async function generateInsight(
  provider: AIProvider,
  params: CompletionParams,
): Promise<GenerateInsightOutcome> {
  const first = await tryOnce(provider, params);
  if (first.ok && first.parsed) {
    return {
      parsed: first.parsed,
      raw: first.raw,
      attempts: 1,
      retried: false,
    };
  }

  // Retry-once with corrective context appended to the user prompt.
  const correction = buildRetryCorrectionMessage(
    first.reason ?? "schema mismatch",
    first.details ?? "",
  );
  const retryParams: CompletionParams = {
    ...params,
    userPrompt: `${params.userPrompt}\n\n${correction}`,
  };
  const second = await tryOnce(provider, retryParams);
  if (second.ok && second.parsed) {
    return {
      parsed: second.parsed,
      raw: second.raw,
      attempts: 2,
      retried: true,
    };
  }

  throw new InsightSchemaError(
    second.reason ?? first.reason ?? "Schema validation failed twice",
    {
      issues: second.zodIssues ?? first.zodIssues,
      attempts: 2,
    },
  );
}
