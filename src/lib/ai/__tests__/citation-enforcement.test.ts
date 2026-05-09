import { describe, it, expect } from "vitest";
import {
  aiInsightResponseSchema,
  findUncitedRecommendations,
  metricSourceSchema,
  aiRecommendationSchema,
  type AIInsightResponse,
} from "../schema";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";

/**
 * Phase C1 — citation-from-data hard requirement.
 *
 * Marc, verbatim 2026-05-09: "es muss sich halt irgendwie stützen auf
 * medizinische Dinge."  ("It must ground on medical facts / user data.")
 *
 * Operational meaning:
 *
 *   1. Every recommendation MUST carry a `metricSource` with all three
 *      required fields populated (`type`, `timeRange`, `summary`).
 *      Empty / missing → schema parse fails. The model cannot
 *      fabricate a recommendation that points at "nothing".
 *
 *   2. Every recommendation's `metricSource` MUST be backed by an
 *      entry in `citations[]` (matching `type` + `timeRange`).
 *      Cross-check enforced by `findUncitedRecommendations` and run
 *      by the wrapper after schema parse.
 *
 *   3. Two separate failure modes (missing metricSource vs. missing
 *      citation) both surface as zod / wrapper errors so the route
 *      can return 422 in either case.
 */

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

const baseValid: AIInsightResponse = {
  summary: "BP runs slightly above your 90-day median.",
  recommendations: [
    {
      id: "rec-1",
      text: "Discuss home BP log with your physician.",
      severity: "important",
      metricSource: baseMetricSource,
    },
  ],
  citations: [baseCitation],
  warnings: [],
};

describe("citation-from-data — schema-level enforcement", () => {
  it("recommendation without metricSource fails parse", () => {
    const broken = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more.",
          severity: "suggestion",
          // metricSource missing entirely
        },
      ],
    };
    const result = aiRecommendationSchema.safeParse(broken.recommendations[0]);
    expect(result.success).toBe(false);
  });

  it("recommendation with empty metricSource.summary fails parse", () => {
    const broken = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-1",
          text: "Walk more.",
          severity: "suggestion",
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "",
          },
        },
      ],
    };
    const result = aiInsightResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("recommendation with missing metricSource.type fails parse", () => {
    const broken = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-1",
          text: "X",
          severity: "info",
          metricSource: { timeRange: "last7days", summary: "data" },
        },
      ],
    };
    const result = aiInsightResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("recommendation with missing metricSource.timeRange fails parse", () => {
    const result = aiInsightResponseSchema.safeParse({
      ...baseValid,
      recommendations: [
        {
          id: "rec-1",
          text: "X",
          severity: "info",
          metricSource: { type: "bloodPressure", summary: "data" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("metricSource alone (without recommendation wrapper) — empty summary still fails", () => {
    const result = metricSourceSchema.safeParse({
      type: "x",
      timeRange: "y",
      summary: "",
    });
    expect(result.success).toBe(false);
  });

  it("well-formed citation gets through", () => {
    const result = aiInsightResponseSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
  });
});

describe("citation-from-data — cross-check enforcement", () => {
  it("recommendation citing a (type, timeRange) absent from citations[] is flagged", () => {
    const orphan: AIInsightResponse = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-orphan",
          text: "Cut sodium.",
          severity: "suggestion",
          metricSource: {
            type: "diet",
            timeRange: "last7days",
            summary: "no diet logging available",
          },
        },
      ],
      citations: [baseCitation], // diet citation missing
    };
    const missing = findUncitedRecommendations(orphan);
    expect(missing).toHaveLength(1);
    expect(missing[0].recommendationId).toBe("rec-orphan");
    expect(missing[0].missing).toEqual({
      type: "diet",
      timeRange: "last7days",
    });
  });

  it("partial-key match on type alone is NOT enough — timeRange must also match", () => {
    const orphan: AIInsightResponse = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-mismatch",
          text: "X",
          severity: "info",
          metricSource: {
            type: "bloodPressure",
            timeRange: "last30days", // citation only covers last7days
            summary: "avg over 30 days",
          },
        },
      ],
      citations: [baseCitation],
    };
    const missing = findUncitedRecommendations(orphan);
    expect(missing).toHaveLength(1);
  });

  it("multiple recommendations sharing the same citation pass once that one citation is present", () => {
    const ok: AIInsightResponse = {
      ...baseValid,
      recommendations: [
        baseValid.recommendations[0],
        {
          id: "rec-2",
          text: "Continue daily logging.",
          severity: "info",
          metricSource: { ...baseMetricSource },
        },
      ],
      citations: [baseCitation],
    };
    const missing = findUncitedRecommendations(ok);
    expect(missing).toEqual([]);
  });
});

describe("citation-from-data — wrapper end-to-end", () => {
  it("uncited recommendation triggers retry; second try with proper citation passes", async () => {
    const orphan = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-orphan",
          text: "Cut sodium.",
          severity: "suggestion",
          metricSource: {
            type: "diet",
            timeRange: "last7days",
            summary: "no diet logging available",
          },
        },
      ],
      citations: [],
    };
    const provider = new MockAIProvider({
      responses: [JSON.stringify(orphan), JSON.stringify(baseValid)],
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(outcome.retried).toBe(true);
    expect(outcome.parsed.recommendations[0].id).toBe("rec-1");
  });

  it("retry-attempt that drops the recommendation rather than fixing the citation also passes", async () => {
    const orphan = {
      ...baseValid,
      recommendations: [
        {
          id: "rec-orphan",
          text: "Cut sodium.",
          severity: "suggestion",
          metricSource: {
            type: "diet",
            timeRange: "last7days",
            summary: "no diet logging available",
          },
        },
      ],
      citations: [],
    };
    // Second attempt — model decides to drop the unsupported recommendation
    // entirely. This is the explicitly-allowed "OMIT it" path from the
    // retry-correction message.
    const droppedRecs = {
      summary: "Insufficient data for actionable recommendations.",
      recommendations: [],
      citations: [],
      warnings: [],
    };
    const provider = new MockAIProvider({
      responses: [JSON.stringify(orphan), JSON.stringify(droppedRecs)],
    });
    const outcome = await generateInsight(provider, {
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(outcome.retried).toBe(true);
    expect(outcome.parsed.recommendations).toHaveLength(0);
  });
});
