import { describe, it, expect } from "vitest";
import { summaryToTrend7Delta } from "../trend-delta";

const STABLE = { slope: 0, direction: "stable" as const, confidence: 0.1 };
const RISING_HALF_PER_DAY = {
  slope: 0.5,
  direction: "up" as const,
  confidence: 0.8,
};
const FALLING_TENTH_PER_DAY = {
  slope: -0.1,
  direction: "down" as const,
  confidence: 0.7,
};

describe("summaryToTrend7Delta()", () => {
  it("returns null when the summary is missing", () => {
    expect(summaryToTrend7Delta(null)).toBeNull();
    expect(summaryToTrend7Delta(undefined)).toBeNull();
  });

  it("returns null when slope7 is not computable (insufficient data)", () => {
    expect(summaryToTrend7Delta({ slope7: null })).toBeNull();
  });

  it("projects slope (units per day) over a 7-day window", () => {
    expect(summaryToTrend7Delta({ slope7: RISING_HALF_PER_DAY })).toBe(3.5);
    // Negative slope produces a negative delta — the tile shows it
    // with the unicode minus sign in the formatter.
    expect(summaryToTrend7Delta({ slope7: FALLING_TENTH_PER_DAY })).toBeCloseTo(
      -0.7,
      3,
    );
  });

  it("returns 0 for a stable slope (the tile then paints ±0)", () => {
    expect(summaryToTrend7Delta({ slope7: STABLE })).toBe(0);
  });
});
