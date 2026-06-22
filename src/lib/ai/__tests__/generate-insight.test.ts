import { describe, it, expect } from "vitest";
import {
  aiInsightResponseSchema,
  findUncitedRecommendations,
  InsightSchemaError,
} from "../schema";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";
import { singleUserTurn, type CompletionParams } from "../types";

/** Read the last user message's text out of a recorded CompletionParams. */
function lastUserText(params: CompletionParams): string {
  for (let i = params.messages.length - 1; i >= 0; i -= 1) {
    const m = params.messages[i];
    if (m.role !== "user") continue;
    return typeof m.content === "string"
      ? m.content
      : m.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
  }
  return "";
}

const validResponse = {
  summary: "Your blood pressure is trending high.",
  recommendations: [
    {
      id: "rec-1",
      text: "Discuss lifestyle and possible medication review with your physician.",
      severity: "important",
      metricSource: {
        type: "bloodPressure",
        timeRange: "last7days",
        summary: "avg 142/88 across 12 readings",
        n: 12,
      },
      rationale: {
        dataWindow: "last7days",
        comparedTo: "your 90-day median (128/82)",
        deviation: "+14/+6 mmHg above baseline over 7 of 7 days",
      },
    },
  ],
  citations: [
    {
      type: "bloodPressure",
      timeRange: "last7days",
      summary: "avg 142/88 across 12 readings",
    },
  ],
  warnings: [
    {
      topic: "blood_pressure",
      message: "Stage 1 hypertension threshold crossed.",
      severity: "important",
    },
  ],
};

describe("aiInsightResponseSchema", () => {
  it("accepts a well-formed strict response", () => {
    const result = aiInsightResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it("permits legacy passthrough fields (back-compat)", () => {
    const withLegacy = {
      ...validResponse,
      classification: "grenzwertig",
      findings: [{ label: "x", value: "y", assessment: "neutral" }],
      disclaimer: "consult your doctor",
    };
    const result = aiInsightResponseSchema.safeParse(withLegacy);
    expect(result.success).toBe(true);
  });

  it("rejects when summary is empty", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...validResponse,
      summary: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a recommendation without metricSource.summary", () => {
    const broken = {
      ...validResponse,
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more",
          severity: "suggestion",
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "", // empty — should fail
          },
        },
      ],
    };
    const result = aiInsightResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects a recommendation with missing severity enum", () => {
    const broken = {
      ...validResponse,
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more",
          severity: "kinda-bad", // not in enum
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "5,000 steps avg",
          },
        },
      ],
    };
    const result = aiInsightResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("findUncitedRecommendations flags recommendations whose metricSource is not in citations", () => {
    const orphan = {
      ...validResponse,
      recommendations: [
        validResponse.recommendations[0],
        {
          id: "rec-2",
          text: "Reduce salt intake",
          severity: "suggestion",
          metricSource: {
            type: "diet",
            timeRange: "last30days",
            summary: "no salt logging available",
          },
          rationale: {
            dataWindow: "last30days",
            comparedTo: "general DGE intake guideline",
            deviation: "n/a — no salt tracking present",
          },
        },
      ],
    };
    const parsed = aiInsightResponseSchema.parse(orphan);
    const missing = findUncitedRecommendations(parsed);
    expect(missing).toHaveLength(1);
    expect(missing[0].recommendationId).toBe("rec-2");
    expect(missing[0].missing.type).toBe("diet");
  });
});

describe("generateInsight wrapper", () => {
  it("returns the parsed response on first-attempt success", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(validResponse),
    });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "sys", user: "user" }),
    );
    expect(outcome.attempts).toBe(1);
    expect(outcome.retried).toBe(false);
    expect(outcome.parsed.summary).toMatch(/blood pressure/);
    expect(provider.callCount).toBe(1);
  });

  it("retries once with correction message and succeeds on second attempt", async () => {
    const provider = new MockAIProvider({
      responses: ["definitely not json", JSON.stringify(validResponse)],
    });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "sys", user: "Original user prompt." }),
    );
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(provider.callCount).toBe(2);
    // The retry call must include the original user prompt PLUS the
    // corrective suffix referencing the schema.
    const retryUserPrompt = lastUserText(provider.calls[1]);
    expect(retryUserPrompt).toContain("Original user prompt.");
    expect(retryUserPrompt).toContain("did not satisfy");
    expect(retryUserPrompt).toContain("metricSource");
  });

  it("throws InsightSchemaError(422) when both attempts fail", async () => {
    const provider = new MockAIProvider({
      responses: ["nope", "still nope"],
    });
    let caught: unknown;
    try {
      await generateInsight(
        provider,
        singleUserTurn({ system: "sys", user: "user" }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InsightSchemaError);
    const err = caught as InsightSchemaError;
    expect(err.httpStatus).toBe(422);
    expect(err.attempts).toBe(2);
    expect(provider.callCount).toBe(2);
  });

  it("retries when first attempt has uncited recommendations", async () => {
    const orphanResponse = {
      ...validResponse,
      recommendations: [
        {
          id: "rec-orphan",
          text: "Cut sugar",
          severity: "suggestion",
          metricSource: {
            type: "diet",
            timeRange: "last7days",
            summary: "no sugar tracking present",
          },
          rationale: {
            dataWindow: "last7days",
            comparedTo: "general DGE intake guideline",
            deviation: "n/a — no sugar tracking present",
          },
        },
      ],
      citations: [], // empty — fails cross-check
    };
    const provider = new MockAIProvider({
      responses: [
        JSON.stringify(orphanResponse),
        JSON.stringify(validResponse),
      ],
    });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "sys", user: "u" }),
    );
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(lastUserText(provider.calls[1])).toContain(
      "metricSources not in citations",
    );
  });

  it("propagates provider-level errors without retrying", async () => {
    const provider = new MockAIProvider({
      rejectWith: Object.assign(new Error("OpenAI request failed (500)"), {
        httpStatus: 500,
      }),
    });
    await expect(
      generateInsight(provider, singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toThrow("OpenAI request failed (500)");
    // Provider only called once — wrapper does not retry on provider errors.
    expect(provider.callCount).toBe(1);
  });
});
