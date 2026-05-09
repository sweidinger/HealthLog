import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";

const annotateMock = vi.fn();

vi.mock("@/lib/logging/context", () => ({
  annotate: (fields: { meta?: Record<string, unknown> }) =>
    annotateMock(fields),
  getEvent: () => null,
}));

/**
 * v1.4.16 phase B5c — wrapper-level rationale handling.
 *
 *   1. The corrective retry message lists the rationale fields so a
 *      first-attempt response without rationale gets a targeted
 *      reprompt (instead of the model guessing what's wrong).
 *   2. The wrapper's post-validation `annotate()` carries a
 *      `ai_rationale_coverage_*` breakdown so the admin AI quality
 *      dashboard can chart per-payload coverage of the new field.
 *      Mirrors the citation-coverage annotations from B5a.
 */

const baseRationale = {
  dataWindow: "last7days" as const,
  comparedTo: "your 90-day median (122/78)",
  deviation: "+16/+8 mmHg above baseline over 9 of 9 readings",
};

const baseMetricSource = {
  type: "bloodPressure",
  timeRange: "last7days",
  summary: "avg 138/86 across 9 readings",
};

const baseCitation = {
  type: "bloodPressure",
  timeRange: "last7days",
  summary: "avg 138/86 across 9 readings",
};

const validResponse = {
  summary: "BP runs slightly above your 90-day median.",
  recommendations: [
    {
      id: "rec-1",
      text: "Discuss home BP log with your physician.",
      severity: "important",
      metricSource: baseMetricSource,
      rationale: baseRationale,
    },
  ],
  citations: [baseCitation],
  warnings: [],
};

describe("generateInsight() — corrective retry mentions rationale", () => {
  beforeEach(() => {
    annotateMock.mockReset();
  });

  it("retries with a corrective message naming dataWindow / comparedTo / deviation when rationale missing", async () => {
    const recWithoutRationale = {
      id: "rec-1",
      text: "Walk more",
      severity: "suggestion",
      metricSource: baseMetricSource,
      // rationale missing
    };
    const broken = {
      ...validResponse,
      recommendations: [recWithoutRationale],
    };
    const provider = new MockAIProvider({
      responses: [JSON.stringify(broken), JSON.stringify(validResponse)],
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "Original user prompt.",
    });
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    const retryUserPrompt = provider.calls[1].userPrompt;
    expect(retryUserPrompt).toContain("Original user prompt.");
    expect(retryUserPrompt).toContain("rationale");
    expect(retryUserPrompt).toContain("dataWindow");
    expect(retryUserPrompt).toContain("comparedTo");
    expect(retryUserPrompt).toContain("deviation");
  });

  it("retries when first attempt has empty rationale.deviation", async () => {
    const recWithEmptyDeviation = {
      id: "rec-1",
      text: "Walk more",
      severity: "suggestion",
      metricSource: baseMetricSource,
      rationale: {
        dataWindow: "last7days",
        comparedTo: "your 90-day median",
        deviation: "", // empty — should fail
      },
    };
    const broken = {
      ...validResponse,
      recommendations: [recWithEmptyDeviation],
    };
    const provider = new MockAIProvider({
      responses: [JSON.stringify(broken), JSON.stringify(validResponse)],
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "user",
    });
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
  });
});

describe("generateInsight() — rationale-coverage annotation", () => {
  beforeEach(() => {
    annotateMock.mockReset();
  });

  it("annotates ai_rationale_coverage_* fields on a successful generation", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(validResponse),
    });
    await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "user",
    });
    expect(annotateMock).toHaveBeenCalled();
    const meta = annotateMock.mock.calls[0][0]?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      ai_total_recommendations: 1,
      ai_rationale_total_recommendations: 1,
      ai_rationale_with_rationale: 1,
      ai_rationale_missing_recommendation_ids: [],
    });
  });

  it("rationale-coverage = total recommendations when every rec carries one", async () => {
    const twoRecs = {
      ...validResponse,
      recommendations: [
        validResponse.recommendations[0],
        {
          id: "rec-2",
          text: "Continue daily logging.",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
    };
    const provider = new MockAIProvider({
      responses: JSON.stringify(twoRecs),
    });
    await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "user",
    });
    const meta = annotateMock.mock.calls[0][0]?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      ai_rationale_total_recommendations: 2,
      ai_rationale_with_rationale: 2,
      ai_rationale_missing_recommendation_ids: [],
    });
  });
});
