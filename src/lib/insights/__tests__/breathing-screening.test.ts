import { describe, it, expect } from "vitest";

import {
  summariseBreathing,
  type BreathingRow,
} from "@/lib/insights/breathing-screening";

function night(daysAgo: number, value: number): BreathingRow {
  return {
    value,
    measuredAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
  };
}

describe("summariseBreathing", () => {
  it("is absent with no rows at all", () => {
    const s = summariseBreathing([], []);
    expect(s.present).toBe(false);
    expect(s.nights).toBe(0);
    expect(s.classification).toBeNull();
    expect(s.trend).toBeNull();
  });

  it("classifies not-elevated with index nights and no events", () => {
    const s = summariseBreathing([night(2, 3), night(1, 4)], []);
    expect(s.present).toBe(true);
    expect(s.nights).toBe(2);
    expect(s.recentMeanIndex).toBe(3.5);
    expect(s.classification).toBe("not-elevated");
  });

  it("classifies elevated when the device flagged events", () => {
    const s = summariseBreathing([night(1, 5)], [night(1, 1)]);
    expect(s.present).toBe(true);
    expect(s.eventCount).toBe(1);
    expect(s.classification).toBe("elevated");
  });

  it("computes an upward trend over enough nights", () => {
    const rows = [
      night(8, 2),
      night(7, 2),
      night(6, 2),
      night(5, 8),
      night(4, 8),
      night(3, 8),
      night(2, 8),
      night(1, 8),
    ];
    const s = summariseBreathing(rows, []);
    expect(s.trend).toBe("up");
  });

  it("leaves the trend null with too few nights", () => {
    const s = summariseBreathing([night(2, 4), night(1, 5)], []);
    expect(s.trend).toBeNull();
  });
});
