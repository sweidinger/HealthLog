import { describe, it, expect, vi } from "vitest";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";
import type { ConfidenceInputs } from "../confidence";

/**
 * v1.4.16 phase B5d — wrapper post-validation override.
 *
 * The model's self-reported `confidence` is DISCARDED. After zod
 * parse succeeds, `generateInsight()` derives `ConfidenceInputs` per
 * recommendation and overwrites `rec.confidence` with the value
 * `computeConfidence()` produces.
 *
 * Default-on per research §7 question 1 (Marc-acked). The override
 * happens whether or not the caller supplies a bucket-series-aware
 * resolver — when the resolver is missing we fall back to inputs
 * derivable from the parsed payload alone (`metricSource.n`,
 * recencyDays=0, deviationStdRatio=null) so the contract is "the
 * confidence on the response NEVER comes from the LLM".
 */

const validResponseWithModelConfidence = {
  summary: "Your blood pressure is trending high.",
  recommendations: [
    {
      id: "rec-1",
      text: "Discuss lifestyle and possible medication review with your physician.",
      severity: "important",
      // Model claims 99 — wrapper must overwrite this.
      confidence: 99,
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
  warnings: [],
};

describe("generateInsight() — confidence override", () => {
  it("overrides model-supplied confidence with deterministic computation (default fallback)", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(validResponseWithModelConfidence),
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "user",
    });
    const rec = outcome.parsed.recommendations[0];
    // Model claimed 99; wrapper must have replaced it.
    // n=12, recencyDays=0 (default), ratio=null (default) →
    // nScore = 10 + 10*log10(12) ≈ 20.79
    // recency = 30 * (1 - 0/30) = 30
    // signal = null → 15
    // total ≈ 65.79 → 66
    expect(rec.confidence).toBe(66);
    expect(rec.confidence).not.toBe(99);
  });

  it("fills in confidence even when the model omitted it", async () => {
    const noConfidence = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          confidence: undefined,
        },
      ],
    };
    // strip the undefined to emulate the model not emitting the key
    const stringified = JSON.stringify(noConfidence);
    const provider = new MockAIProvider({ responses: stringified });
    const outcome = await generateInsight(provider, {
      systemPrompt: "sys",
      userPrompt: "u",
    });
    expect(outcome.parsed.recommendations[0].confidence).toBe(66);
  });

  it("uses the resolver-supplied ConfidenceInputs when provided", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify(validResponseWithModelConfidence),
    });
    const resolver = vi.fn(
      (): ConfidenceInputs => ({
        n: 14,
        recencyDays: 1,
        deviationStdRatio: 2,
      }),
    );
    const outcome = await generateInsight(
      provider,
      { systemPrompt: "s", userPrompt: "u" },
      { confidenceContext: resolver },
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    // n=14 fresh strong signal → ~80
    expect(outcome.parsed.recommendations[0].confidence).toBe(80);
  });

  it("hard-caps confidence to <=15 when n<3 (small-data shield)", async () => {
    const tinyN = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          metricSource: {
            ...validResponseWithModelConfidence.recommendations[0]
              .metricSource,
            n: 1,
          },
        },
      ],
    };
    const provider = new MockAIProvider({ responses: JSON.stringify(tinyN) });
    const outcome = await generateInsight(provider, {
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(outcome.parsed.recommendations[0].confidence).toBeLessThanOrEqual(
      15,
    );
  });

  it("treats missing metricSource.n as n=0 (hard-cap)", async () => {
    const noN = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          metricSource: {
            type: "bloodPressure",
            timeRange: "last7days",
            summary: "avg 142/88 across 12 readings",
            // n omitted
          },
        },
      ],
    };
    const provider = new MockAIProvider({ responses: JSON.stringify(noN) });
    const outcome = await generateInsight(provider, {
      systemPrompt: "s",
      userPrompt: "u",
    });
    // n=0 → hard-cap floor 10
    expect(outcome.parsed.recommendations[0].confidence).toBe(10);
  });

  it("calls the resolver per-recommendation with the rec passed in", async () => {
    const twoRecs = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          id: "rec-a",
        },
        {
          ...validResponseWithModelConfidence.recommendations[0],
          id: "rec-b",
          metricSource: {
            ...validResponseWithModelConfidence.recommendations[0]
              .metricSource,
            n: 5,
          },
        },
      ],
    };
    const provider = new MockAIProvider({
      responses: JSON.stringify(twoRecs),
    });
    const seenIds: string[] = [];
    const resolver = (rec: { id: string }) => {
      seenIds.push(rec.id);
      return { n: 14, recencyDays: 1, deviationStdRatio: 2 };
    };
    const outcome = await generateInsight(
      provider,
      { systemPrompt: "s", userPrompt: "u" },
      { confidenceContext: resolver },
    );
    expect(seenIds).toEqual(["rec-a", "rec-b"]);
    expect(outcome.parsed.recommendations.every((r) => r.confidence === 80)).toBe(
      true,
    );
  });
});
