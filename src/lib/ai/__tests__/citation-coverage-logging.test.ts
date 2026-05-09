import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateInsight } from "../generate-insight";
import { MockAIProvider } from "../mock-client";
import {
  detectsNormativeClaim,
  computeCitationCoverage,
} from "../citation-coverage";
import { MEDICAL_REFERENCES } from "../medical-references";

const annotateMock = vi.fn();

vi.mock("@/lib/logging/context", () => ({
  annotate: (fields: { meta?: Record<string, unknown> }) =>
    annotateMock(fields),
  getEvent: () => null,
}));

const knownRefId = MEDICAL_REFERENCES[0].id;

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

const baseRationale = {
  dataWindow: "last7days" as const,
  comparedTo: "your 90-day median (128/82)",
  deviation: "+10/+4 mmHg above baseline",
};

/**
 * v1.4.16 phase B5a — citation-coverage post-validation logging.
 *
 * After the schema parse + cross-citation check pass, the wrapper
 * counts how many recommendations make a normative claim and how
 * many of those carry a referenceId. The result lands as a Wide-Event
 * meta annotation so the admin AI quality dashboard (planned) can
 * track citation-coverage over time.
 *
 * The check is observational only in v1.4.16 — a rec that should cite
 * but doesn't gets logged, never raises a parse error. v1.4.16 phase
 * B5c flips it to required for severity >= "important".
 */

describe("detectsNormativeClaim()", () => {
  it("detects 'target' in the rec text", () => {
    expect(detectsNormativeClaim("Aim for a BP target below 130/80")).toBe(
      true,
    );
  });

  it("detects 'should' in the rec text", () => {
    expect(detectsNormativeClaim("Your BP should stay below 140/90")).toBe(
      true,
    );
  });

  it("detects 'normal range' in the rec text", () => {
    expect(detectsNormativeClaim("Pulse is within the normal range")).toBe(
      true,
    );
  });

  it("detects 'above' in the rec text", () => {
    expect(
      detectsNormativeClaim("Reading is above the recommended ceiling"),
    ).toBe(true);
  });

  it("detects 'below' in the rec text", () => {
    expect(detectsNormativeClaim("Reading is below the lower threshold")).toBe(
      true,
    );
  });

  it("returns false for purely observational text", () => {
    expect(
      detectsNormativeClaim(
        "Your avg7 (78 bpm) is 5 bpm higher than your 90-day median (73 bpm)",
      ),
    ).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(detectsNormativeClaim("TARGET range exceeded")).toBe(true);
    expect(detectsNormativeClaim("Target range exceeded")).toBe(true);
    expect(detectsNormativeClaim("target range exceeded")).toBe(true);
  });
});

describe("computeCitationCoverage()", () => {
  it("counts an empty recommendations[] as zero / zero", () => {
    expect(
      computeCitationCoverage({
        summary: "x",
        recommendations: [],
        citations: [],
        warnings: [],
      }),
    ).toEqual({
      totalRecommendations: 0,
      normativeRecommendations: 0,
      citedNormativeRecommendations: 0,
      uncitedNormativeRecommendationIds: [],
    });
  });

  it("counts a normative rec with referenceId as cited", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-1",
          text: "Aim for a target below 140/90",
          severity: "important",
          metricSource: baseMetricSource,
          rationale: baseRationale,
          referenceId: knownRefId,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.totalRecommendations).toBe(1);
    expect(result.normativeRecommendations).toBe(1);
    expect(result.citedNormativeRecommendations).toBe(1);
    expect(result.uncitedNormativeRecommendationIds).toEqual([]);
  });

  it("flags a normative rec without referenceId as uncited", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-naked-target",
          text: "Aim for a target below 140/90",
          severity: "important",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.normativeRecommendations).toBe(1);
    expect(result.citedNormativeRecommendations).toBe(0);
    expect(result.uncitedNormativeRecommendationIds).toEqual([
      "rec-naked-target",
    ]);
  });

  it("does NOT flag observational recs as uncited", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-observational",
          text: "Your avg7 (78 bpm) is 5 bpm higher than your 90-day median",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.normativeRecommendations).toBe(0);
    expect(result.citedNormativeRecommendations).toBe(0);
    expect(result.uncitedNormativeRecommendationIds).toEqual([]);
  });

  it("flags 'above' / 'below' as normative — they imply a threshold", () => {
    // The heuristic intentionally treats "5 mmHg above your 90-day
    // median" as a normative claim because the comparison invokes a
    // baseline threshold; the rec should cite the source of that
    // baseline (or be reworded to drop the threshold language).
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "rec-threshold",
          text: "Your avg7 is 5 mmHg above your 90-day median",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.normativeRecommendations).toBe(1);
  });

  it("mixes cited / uncited / observational correctly", () => {
    const result = computeCitationCoverage({
      summary: "x",
      recommendations: [
        {
          id: "cited-1",
          text: "Aim for target range 130/80",
          severity: "important",
          metricSource: baseMetricSource,
          rationale: baseRationale,
          referenceId: knownRefId,
        },
        {
          id: "uncited-1",
          text: "Your weight should drop by 2 kg",
          severity: "suggestion",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
        {
          id: "observational-1",
          // No normative keyword — pure within-user comparison.
          text: "Your avg7 (78 bpm) is 5 bpm higher than your 90-day median",
          severity: "info",
          metricSource: baseMetricSource,
          rationale: baseRationale,
        },
      ],
      citations: [baseCitation],
      warnings: [],
    });
    expect(result.totalRecommendations).toBe(3);
    expect(result.normativeRecommendations).toBe(2);
    expect(result.citedNormativeRecommendations).toBe(1);
    expect(result.uncitedNormativeRecommendationIds).toEqual(["uncited-1"]);
  });
});

describe("generateInsight() — citation-coverage annotation", () => {
  beforeEach(() => {
    annotateMock.mockReset();
  });

  it("emits an annotate() call with the coverage breakdown on success", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify({
        summary: "x",
        recommendations: [
          {
            id: "rec-cited",
            text: "Aim for a target below 140/90",
            severity: "important",
            metricSource: baseMetricSource,
            rationale: baseRationale,
            referenceId: knownRefId,
          },
        ],
        citations: [baseCitation],
        warnings: [],
      }),
    });
    await generateInsight(provider, {
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(annotateMock).toHaveBeenCalledTimes(1);
    const meta = annotateMock.mock.calls[0][0]?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      ai_total_recommendations: 1,
      ai_normative_recommendations: 1,
      ai_cited_normative_recommendations: 1,
      ai_uncited_normative_recommendation_ids: [],
    });
  });

  it("annotation flags the uncited normative rec", async () => {
    const provider = new MockAIProvider({
      responses: JSON.stringify({
        summary: "x",
        recommendations: [
          {
            id: "rec-naked",
            text: "Your BP should stay below 140/90",
            severity: "important",
            metricSource: baseMetricSource,
            rationale: baseRationale,
          },
        ],
        citations: [baseCitation],
        warnings: [],
      }),
    });
    await generateInsight(provider, {
      systemPrompt: "system",
      userPrompt: "user",
    });
    expect(annotateMock).toHaveBeenCalledTimes(1);
    const meta = annotateMock.mock.calls[0][0]?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({
      ai_normative_recommendations: 1,
      ai_cited_normative_recommendations: 0,
      ai_uncited_normative_recommendation_ids: ["rec-naked"],
    });
  });

  it("does NOT annotate when generation throws (only on success)", async () => {
    // Provider returns invalid JSON twice → InsightSchemaError surfaces.
    const provider = new MockAIProvider({
      responses: ["not json", "still not json"],
    });
    await expect(
      generateInsight(provider, { systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow();
    expect(annotateMock).not.toHaveBeenCalled();
  });
});
