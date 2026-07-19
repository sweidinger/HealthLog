import { describe, it, expect, vi } from "vitest";
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
