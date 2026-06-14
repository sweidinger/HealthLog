import { describe, it, expect } from "vitest";

import {
  computeWindowConfidence,
  MIN_READINGS_FOR_CONFIDENCE,
} from "../window-confidence";

const NOW = new Date("2026-06-14T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe("computeWindowConfidence", () => {
  it("flags a sample below the floor as insufficient", () => {
    for (const count of [0, 1, 4]) {
      const c = computeWindowConfidence({
        windowDays: 90,
        readingCount: count,
        earliestReadingAt: count === 0 ? null : daysAgo(10),
        now: NOW,
      });
      expect(c.sufficient).toBe(false);
    }
  });

  it("flags a sample at or above the floor as sufficient", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: MIN_READINGS_FOR_CONFIDENCE,
      earliestReadingAt: daysAgo(10),
      now: NOW,
    });
    expect(c.sufficient).toBe(true);
  });

  it("returns a null span when the window is empty", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 0,
      earliestReadingAt: null,
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBeNull();
  });

  it("reports the real span until history reaches the window", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 8,
      earliestReadingAt: daysAgo(23),
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBe(23);
  });

  it("caps the span at the window once history exceeds it", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 120,
      earliestReadingAt: daysAgo(400),
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBe(90);
  });

  it("rounds a same-day-only sample up to one day", () => {
    const c = computeWindowConfidence({
      windowDays: 90,
      readingCount: 5,
      earliestReadingAt: new Date(NOW.getTime() - 60 * 1000),
      now: NOW,
    });
    expect(c.effectiveSpanDays).toBe(1);
  });
});
