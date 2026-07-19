import { describe, it, expect } from "vitest";
import { aiInsightResponseSchema } from "../schema";
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
});
