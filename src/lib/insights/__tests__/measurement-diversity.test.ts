import { describe, it, expect } from "vitest";

import { detectMeasurementDiversity } from "../measurement-diversity";

/**
 * v1.8.5 — measurement-diversity detection.
 *
 * The nudge fires when a metric's readings cluster on a single weekday
 * or a narrow time-of-day band, hinting the user to spread their
 * measurements for a fuller picture. Pure function over ISO timestamps
 * so the unit test pins the thresholds without a DOM.
 */

// Build N ISO timestamps, all on the same weekday (Tuesdays) at 09:00.
function tuesdaysAt(hour: number, count: number): string[] {
  // 2026-06-02 is a Tuesday.
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(2026, 5, 2 + i * 7, hour, 0, 0);
    out.push(d.toISOString());
  }
  return out;
}

// Build N timestamps spread across every weekday at varied hours.
function spreadAcrossWeek(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(2026, 5, 1 + i, 6 + (i % 12), 0, 0);
    out.push(d.toISOString());
  }
  return out;
}

describe("detectMeasurementDiversity", () => {
  it("returns null below the minimum sample floor", () => {
    expect(detectMeasurementDiversity(tuesdaysAt(9, 3))).toBeNull();
  });

  it("flags a weekday cluster when most readings fall on one day", () => {
    const result = detectMeasurementDiversity(tuesdaysAt(9, 10));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("weekday");
  });

  it("flags a time-of-day cluster when the weekday is spread", () => {
    // Spread across weekdays but every reading at 08:00 → time cluster.
    const sameHour: string[] = [];
    for (let i = 0; i < 12; i++) {
      sameHour.push(new Date(2026, 5, 1 + i, 8, 0, 0).toISOString());
    }
    const result = detectMeasurementDiversity(sameHour);
    expect(result?.kind).toBe("timeOfDay");
  });

  it("returns null for well-spread readings", () => {
    expect(detectMeasurementDiversity(spreadAcrossWeek(14))).toBeNull();
  });

  it("ignores invalid timestamps without throwing", () => {
    const mixed = [...tuesdaysAt(9, 10), "not-a-date", ""];
    const result = detectMeasurementDiversity(mixed);
    expect(result?.kind).toBe("weekday");
  });
});
