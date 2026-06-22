import { describe, it, expect } from "vitest";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";
import { singleUserTurn } from "../types";

/**
 * v1.4.16 phase B5d — wrapper post-validation override.
 *
 * The model's self-reported `confidence` is DISCARDED. After zod
 * parse succeeds, `generateInsight()` derives `ConfidenceInputs` per
 * recommendation and overwrites `rec.confidence` with the value
 * `computeConfidence()` produces.
 *
 * Default-on per research §7 question 1 (maintainer-acked). The override
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
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "sys", user: "user" }),
    );
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
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "sys", user: "u" }),
    );
    expect(outcome.parsed.recommendations[0].confidence).toBe(66);
  });

  it("derives n from metricSource.n on the parsed payload (no caller injection)", async () => {
    // v1.4.16 phase D reconcile (simplify F2) — the wrapper used to
    // accept an optional `confidenceContext` resolver, but no production
    // caller ever passed one. Inputs are derived from the payload alone
    // today; v1.4.17's feedback ratchet will re-introduce a resolver
    // injection when a real second caller exists.
    const fourteenN = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          metricSource: {
            ...validResponseWithModelConfidence.recommendations[0].metricSource,
            n: 14,
          },
        },
      ],
    };
    const provider = new MockAIProvider({
      responses: JSON.stringify(fourteenN),
    });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "s", user: "u" }),
    );
    // n=14, recencyDays=0, ratio=null → 10 + 10*log10(14) + 30 + 15 ≈ 66.46
    expect(outcome.parsed.recommendations[0].confidence).toBe(66);
  });

  it("hard-caps confidence to <=15 when n<3 (small-data shield)", async () => {
    const tinyN = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          metricSource: {
            ...validResponseWithModelConfidence.recommendations[0].metricSource,
            n: 1,
          },
        },
      ],
    };
    const provider = new MockAIProvider({ responses: JSON.stringify(tinyN) });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "s", user: "u" }),
    );
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
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "s", user: "u" }),
    );
    // n=0 → hard-cap floor 10
    expect(outcome.parsed.recommendations[0].confidence).toBe(10);
  });

  it("overrides confidence on every recommendation in payload order", async () => {
    const twoRecs = {
      ...validResponseWithModelConfidence,
      recommendations: [
        {
          ...validResponseWithModelConfidence.recommendations[0],
          id: "rec-a",
          confidence: 99,
        },
        {
          ...validResponseWithModelConfidence.recommendations[0],
          id: "rec-b",
          confidence: 1,
          metricSource: {
            ...validResponseWithModelConfidence.recommendations[0].metricSource,
            n: 5,
          },
        },
      ],
    };
    const provider = new MockAIProvider({
      responses: JSON.stringify(twoRecs),
    });
    const outcome = await generateInsight(
      provider,
      singleUserTurn({ system: "s", user: "u" }),
    );
    // Model claimed (99, 1); both must be discarded and replaced with
    // the deterministic value (n=12 → 66, n=5 → 62 from the saturating
    // formula 10 + 10*log10(5) + 30 + 15 ≈ 61.99).
    expect(outcome.parsed.recommendations[0].confidence).toBe(66);
    expect(outcome.parsed.recommendations[1].confidence).toBe(62);
  });
});
