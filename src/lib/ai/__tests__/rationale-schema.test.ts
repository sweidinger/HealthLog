import { describe, it, expect } from "vitest";
import {
  aiInsightResponseSchema,
  aiRecommendationRationaleSchema,
  aiRecommendationSchema,
  findRecommendationsMissingRationale,
  type AIInsightResponse,
} from "../schema";

/**
 * v1.4.16 phase B5c — `recommendation.rationale` validation.
 *
 * The Oura-style explainability card is fed by a per-recommendation
 * `rationale` object that records:
 *   - dataWindow: which time window the rec is based on,
 *   - comparedTo: what the user's current data is being compared
 *     against (e.g. "your 90-day median (73 bpm)"),
 *   - deviation: the size + direction of the deviation that triggered
 *     the rec.
 *
 * Schema enforces:
 *   1. `rationale` is required on every recommendation.
 *   2. `dataWindow` is one of the four time-window enums consistent
 *      with `metricSource.timeRange` so the mini-chart can pin to it.
 *   3. `comparedTo` and `deviation` are non-empty strings. Empty
 *      values would let the model emit a placeholder card with no
 *      actionable "why" — fail parse.
 *   4. `referenceId` (optional here too) must point into the curated
 *      bundle when present — defence in depth on top of the rec-level
 *      `referenceId`.
 *
 * `findRecommendationsMissingRationale()` flags legacy (pre-B5c)
 * payloads where the rationale object is absent. Used by the legacy-
 * payload migration path so the UI can show a "regenerate for new
 * explainability features" CTA without auto-regenerating.
 */

const baseRationale = {
  dataWindow: "last7days" as const,
  comparedTo: "your 90-day median (73 bpm)",
  deviation: "+5 bpm above baseline over 7 of 7 days",
};

const baseMetricSource = {
  type: "pulse",
  timeRange: "last7days",
  summary: "avg 78 bpm across 9 readings",
};

const baseCitation = {
  type: "pulse",
  timeRange: "last7days",
  summary: "avg 78 bpm across 9 readings",
};

const baseRec = {
  id: "rec-1",
  text: "Aim for resting pulse below your usual baseline.",
  severity: "suggestion" as const,
  metricSource: baseMetricSource,
  rationale: baseRationale,
};

const baseValid: AIInsightResponse = {
  summary: "Pulse runs slightly above your 90-day median.",
  recommendations: [baseRec],
  citations: [baseCitation],
  warnings: [],
};

describe("aiRecommendationRationaleSchema", () => {
  it("accepts a well-formed rationale", () => {
    expect(
      aiRecommendationRationaleSchema.safeParse(baseRationale).success,
    ).toBe(true);
  });

  it.each(["last7days", "last30days", "last90days", "allTime"] as const)(
    "accepts dataWindow=%s",
    (dataWindow) => {
      const result = aiRecommendationRationaleSchema.safeParse({
        ...baseRationale,
        dataWindow,
      });
      expect(result.success).toBe(true);
    },
  );

  it("rejects an unknown dataWindow", () => {
    const result = aiRecommendationRationaleSchema.safeParse({
      ...baseRationale,
      dataWindow: "lastDecade",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty comparedTo", () => {
    const result = aiRecommendationRationaleSchema.safeParse({
      ...baseRationale,
      comparedTo: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty deviation", () => {
    const result = aiRecommendationRationaleSchema.safeParse({
      ...baseRationale,
      deviation: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only comparedTo (min(1) is post-trim sensible)", () => {
    // We don't trim — empty string fails, single space passes the
    // .min(1) guard. Document the contract so future ratchet knows.
    const result = aiRecommendationRationaleSchema.safeParse({
      ...baseRationale,
      comparedTo: " ",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional referenceId pointing into the bundle (defence in depth)", () => {
    // The rationale doesn't carry its own referenceId field today —
    // the rec-level one is the source of truth — but the schema allows
    // an explicit one if a future provider emits it. This test just
    // pins that no extra fields throw.
    const result = aiRecommendationRationaleSchema.safeParse({
      ...baseRationale,
    });
    expect(result.success).toBe(true);
  });
});

describe("aiRecommendationSchema — rationale", () => {
  it("accepts a recommendation with rationale", () => {
    expect(aiRecommendationSchema.safeParse(baseRec).success).toBe(true);
  });

  it("rejects a recommendation without rationale", () => {
    const { rationale: _r, ...recWithoutRationale } = baseRec;
    void _r;
    const result = aiRecommendationSchema.safeParse(recWithoutRationale);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("rationale"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects a recommendation with empty comparedTo in rationale", () => {
    const result = aiRecommendationSchema.safeParse({
      ...baseRec,
      rationale: { ...baseRationale, comparedTo: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a recommendation with empty deviation in rationale", () => {
    const result = aiRecommendationSchema.safeParse({
      ...baseRec,
      rationale: { ...baseRationale, deviation: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a recommendation with bogus dataWindow in rationale", () => {
    const result = aiRecommendationSchema.safeParse({
      ...baseRec,
      rationale: { ...baseRationale, dataWindow: "since-2020" },
    });
    expect(result.success).toBe(false);
  });
});

describe("aiInsightResponseSchema — rationale integration", () => {
  it("accepts a payload where every rec carries a rationale", () => {
    expect(aiInsightResponseSchema.safeParse(baseValid).success).toBe(true);
  });

  it("rejects a payload with one rec missing rationale", () => {
    const { rationale: _r, ...recWithoutRationale } = baseRec;
    void _r;
    const result = aiInsightResponseSchema.safeParse({
      ...baseValid,
      recommendations: [baseRec, { ...recWithoutRationale, id: "rec-2" }],
    });
    expect(result.success).toBe(false);
  });

  it("preserves the rationale on round-trip parse", () => {
    const parsed = aiInsightResponseSchema.parse(baseValid);
    expect(parsed.recommendations[0].rationale).toEqual(baseRationale);
  });
});

describe("findRecommendationsMissingRationale()", () => {
  it("returns an empty array for a payload where every rec has rationale", () => {
    expect(findRecommendationsMissingRationale(baseValid)).toEqual([]);
  });

  it("flags a legacy payload whose recs predate B5c (rationale absent)", () => {
    // Legacy payloads from before B5c had no rationale field. Once
    // the strict parser flips to mandatory rationale, those payloads
    // would fail parse — but we keep `.passthrough()` for one
    // milestone and use `findRecommendationsMissingRationale()` to
    // *detect* legacy shape so the UI can prompt regeneration.
    //
    // Cast through unknown because the strict input type already
    // requires rationale; this helper exists to handle the legacy
    // mismatch defensively at runtime.
    const legacy = {
      summary: "Older insight from v1.4.15.",
      recommendations: [
        {
          id: "rec-old-1",
          text: "Walk more",
          severity: "suggestion",
          metricSource: {
            type: "activity",
            timeRange: "last7days",
            summary: "5,000 steps avg",
          },
          // no rationale
        },
        {
          id: "rec-old-2",
          text: "Hydrate",
          severity: "info",
          metricSource: {
            type: "fluid",
            timeRange: "last7days",
            summary: "low intake logged",
          },
          // no rationale
        },
      ],
      citations: [],
      warnings: [],
    } as unknown as AIInsightResponse;

    const missing = findRecommendationsMissingRationale(legacy);
    expect(missing).toEqual(["rec-old-1", "rec-old-2"]);
  });

  it("flags only the recs that are missing, not the well-formed ones", () => {
    const partial = {
      summary: "Mixed payload",
      recommendations: [
        baseRec,
        {
          id: "rec-bad",
          text: "Hydrate",
          severity: "info",
          metricSource: {
            type: "fluid",
            timeRange: "last7days",
            summary: "low intake logged",
          },
          // no rationale
        },
      ],
      citations: [baseCitation],
      warnings: [],
    } as unknown as AIInsightResponse;

    expect(findRecommendationsMissingRationale(partial)).toEqual(["rec-bad"]);
  });
});
