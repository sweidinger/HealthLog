import { describe, it, expect } from "vitest";
import { beforeAfterFromSeries } from "@/lib/medications/efficacy/build-efficacy";

const DAY = 24 * 60 * 60 * 1000;
const pivot = Date.parse("2026-03-01T12:00:00Z");

/** Build a run of daily points at a fixed value ending `endOffsetDays` from pivot. */
function run(
  value: number,
  count: number,
  startOffsetDays: number,
): { at: number; value: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    at: pivot + (startOffsetDays + i) * DAY,
    value,
  }));
}

describe("beforeAfterFromSeries — honest before/after card", () => {
  it("returns no_start when there is no pivot", () => {
    expect(beforeAfterFromSeries(run(120, 20, -10), null)).toEqual({
      present: false,
      reason: "no_start",
    });
  });

  it("flags insufficient_before below the per-side floor", () => {
    // Only 2 readings before the pivot (floor is 5).
    const before = run(150, 2, -3);
    const after = run(132, 10, 0);
    const r = beforeAfterFromSeries([...before, ...after], pivot);
    expect(r.present).toBe(false);
    expect(r.reason).toBe("insufficient_before");
  });

  it("flags insufficient_after below the per-side floor", () => {
    const before = run(150, 10, -20);
    const after = run(132, 2, 0);
    const r = beforeAfterFromSeries([...before, ...after], pivot);
    expect(r.present).toBe(false);
    expect(r.reason).toBe("insufficient_after");
  });

  it("computes a neutral before/after delta when both sides clear the floor", () => {
    const before = run(150, 8, -20); // within the 56-day before window
    const after = run(132, 8, 0);
    const r = beforeAfterFromSeries([...before, ...after], pivot);
    expect(r.present).toBe(true);
    expect(r.before?.mean).toBe(150);
    expect(r.after?.mean).toBe(132);
    expect(r.delta?.mean).toBe(-18);
    expect(r.delta?.pct).toBe(-12);
  });

  it("excludes readings older than the 56-day before window", () => {
    // 8 readings but far in the past (beyond the 56-day reach): the before
    // side falls under the floor, so no fabricated delta.
    const before = run(150, 8, -120);
    const after = run(132, 8, 0);
    const r = beforeAfterFromSeries([...before, ...after], pivot);
    expect(r.present).toBe(false);
    expect(r.reason).toBe("insufficient_before");
  });
});
