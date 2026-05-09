import { describe, it, expect } from "vitest";
import {
  aiInsightResponseSchema,
  findUncitedRecommendations,
  InsightSchemaError,
} from "../schema";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";

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
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "user",
    });
    expect(outcome.attempts).toBe(1);
    expect(outcome.retried).toBe(false);
    expect(outcome.parsed.summary).toMatch(/blood pressure/);
    expect(provider.callCount).toBe(1);
  });

  it("retries once with correction message and succeeds on second attempt", async () => {
    const provider = new MockAIProvider({
      responses: ["definitely not json", JSON.stringify(validResponse)],
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "Original user prompt.",
    });
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(provider.callCount).toBe(2);
    // The retry call must include the original user prompt PLUS the
    // corrective suffix referencing the schema.
    const retryUserPrompt = provider.calls[1].userPrompt;
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
      await generateInsight(provider, {
        systemPrompt: "sys",
        userPrompt: "user",
      });
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
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "u",
    });
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(provider.calls[1].userPrompt).toContain(
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
      generateInsight(provider, { systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow("OpenAI request failed (500)");
    // Provider only called once — wrapper does not retry on provider errors.
    expect(provider.callCount).toBe(1);
  });
});
