import { describe, it, expect } from "vitest";

import { normaliseDays, normaliseDateRange } from "../doctor-report-data";

describe("normaliseDays", () => {
  it("returns the value when it's a valid integer in [1, 365]", () => {
    expect(normaliseDays(1)).toBe(1);
    expect(normaliseDays(90)).toBe(90);
    expect(normaliseDays(365)).toBe(365);
  });

  it("falls back to 90 for invalid input", () => {
    expect(normaliseDays(undefined)).toBe(90);
    expect(normaliseDays(0)).toBe(90);
    expect(normaliseDays(-1)).toBe(90);
    expect(normaliseDays(366)).toBe(90);
    expect(normaliseDays(7.5)).toBe(90);
    expect(normaliseDays("90")).toBe(90);
    expect(normaliseDays(null)).toBe(90);
  });

  it("respects a custom fallback", () => {
    expect(normaliseDays(undefined, 30)).toBe(30);
  });
});

describe("normaliseDateRange", () => {
  const NOW = new Date("2026-05-09T12:00:00.000Z");

  it("uses the explicit range when both dates are valid and span <= 730 days", () => {
    const range = normaliseDateRange(
      {
        startDate: "2026-02-01T00:00:00.000Z",
        endDate: "2026-05-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    // 89-day span rounded up to the inclusive day-count.
    expect(range.days).toBe(89);
  });

  it("falls back to last-90-days when range is missing", () => {
    const range = normaliseDateRange({}, NOW);
    expect(range.days).toBe(90);
    expect(range.end.toISOString()).toBe(NOW.toISOString());
    const expectedStart = new Date(NOW);
    expectedStart.setDate(expectedStart.getDate() - 90);
    expect(range.start.toISOString()).toBe(expectedStart.toISOString());
  });

  it("falls back when endDate is before startDate", () => {
    const range = normaliseDateRange(
      {
        startDate: "2026-05-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBe(90);
  });

  it("falls back when range exceeds 730 days", () => {
    const range = normaliseDateRange(
      {
        startDate: "2023-01-01T00:00:00.000Z",
        endDate: "2026-01-01T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBe(90);
  });

  it("accepts the maximum 730-day window", () => {
    const range = normaliseDateRange(
      {
        startDate: "2024-05-09T00:00:00.000Z",
        endDate: "2026-05-09T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBeGreaterThan(700);
    expect(range.days).toBeLessThanOrEqual(730);
  });

  it("falls back when startDate is unparseable", () => {
    const range = normaliseDateRange(
      { startDate: "not-a-date", endDate: "2026-05-01T00:00:00.000Z" },
      NOW,
    );
    expect(range.days).toBe(90);
  });

  it("uses the legacy days fallback when only days is provided", () => {
    const range = normaliseDateRange({ days: 30 }, NOW);
    expect(range.days).toBe(30);
    expect(range.end.toISOString()).toBe(NOW.toISOString());
  });

  it("equal start+end produces a 1-day window (not zero)", () => {
    const range = normaliseDateRange(
      {
        startDate: "2026-05-09T00:00:00.000Z",
        endDate: "2026-05-09T00:00:00.000Z",
      },
      NOW,
    );
    expect(range.days).toBe(1);
  });

  it("ignores non-object input", () => {
    const range = normaliseDateRange("not-an-object", NOW);
    expect(range.days).toBe(90);
  });
});

