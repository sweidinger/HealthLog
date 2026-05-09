import { describe, it, expect } from "vitest";
import { recommendationFeedbackRequestSchema } from "../recommendation-feedback";

describe("recommendationFeedbackRequestSchema", () => {
  const baseValid = {
    recommendationId: "rec-1",
    recommendationText: "Discuss home BP log with your physician.",
    recommendationSeverity: "important" as const,
    metricSourceType: "bloodPressure",
    metricSourceTimeRange: "last7days" as const,
    helpful: true,
  };

  it("accepts a valid payload", () => {
    const parsed = recommendationFeedbackRequestSchema.safeParse(baseValid);
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown severity (defence against poisoning the aggregator)", () => {
    const parsed = recommendationFeedbackRequestSchema.safeParse({
      ...baseValid,
      recommendationSeverity: "wat",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown time-range value", () => {
    const parsed = recommendationFeedbackRequestSchema.safeParse({
      ...baseValid,
      metricSourceTimeRange: "lastFortnight",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty recommendation id", () => {
    const parsed = recommendationFeedbackRequestSchema.safeParse({
      ...baseValid,
      recommendationId: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an empty recommendation text", () => {
    const parsed = recommendationFeedbackRequestSchema.safeParse({
      ...baseValid,
      recommendationText: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-boolean helpful field (catches stringified-boolean clients)", () => {
    const parsed = recommendationFeedbackRequestSchema.safeParse({
      ...baseValid,
      helpful: "true",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects extra fields when stripping isn't desired (helpful is the only thumbs verb)", () => {
    // Zod default behaviour: passthrough is OFF; unknown keys are
    // dropped. We don't use .strict() so a future field can be added
    // additively, but the parsed value must not carry the extra field.
    const parsed = recommendationFeedbackRequestSchema.safeParse({
      ...baseValid,
      providerType: "codex",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("providerType" in parsed.data).toBe(false);
    }
  });
});
