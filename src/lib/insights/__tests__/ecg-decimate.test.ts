import { describe, expect, it } from "vitest";

import { ECG_DISPLAY_TARGET_POINTS, decimateMinMax } from "../ecg-decimate";

/**
 * v1.28.50 — ECG min/max decimation.
 *
 * The load-bearing property: reducing ~9000 samples to ~2500 display points
 * must PRESERVE the R-wave peaks (the global min and max of every bucket
 * survive), unlike a naive stride-decimation which would drop the spikes
 * that sit between kept indices and misrepresent the trace.
 */

describe("decimateMinMax", () => {
  it("returns the input unchanged when already at or below the target", () => {
    const samples = [1, 2, 3, 4, 5];
    expect(decimateMinMax(samples, 10)).toEqual(samples);
    expect(decimateMinMax(samples, 5)).toEqual(samples);
    // A copy, not the same reference (callers must not mutate the source).
    expect(decimateMinMax(samples, 10)).not.toBe(samples);
  });

  it("returns an empty array for empty input", () => {
    expect(decimateMinMax([], 2500)).toEqual([]);
  });

  it("returns the raw array for a non-positive target", () => {
    expect(decimateMinMax([1, 2, 3, 4], 0)).toEqual([1, 2, 3, 4]);
    expect(decimateMinMax([1, 2, 3, 4], -5)).toEqual([1, 2, 3, 4]);
  });

  it("reduces a large array to roughly the point budget", () => {
    const n = 9000;
    const samples = Array.from({ length: n }, (_, i) => Math.sin(i / 10));
    const out = decimateMinMax(samples, ECG_DISPLAY_TARGET_POINTS);
    expect(out.length).toBeLessThanOrEqual(ECG_DISPLAY_TARGET_POINTS);
    // Two points per bucket ⇒ within a small factor of the budget.
    expect(out.length).toBeGreaterThan(ECG_DISPLAY_TARGET_POINTS / 2);
    expect(out.length).toBeLessThan(n);
  });

  it("preserves the global maximum (R-wave peak) hidden between strides", () => {
    // A flat baseline with a single tall spike that a stride-decimation at
    // this ratio would step right over.
    const n = 6000;
    const samples = new Array<number>(n).fill(0);
    const spikeIdx = 1234;
    samples[spikeIdx] = 5000; // the R-wave
    const trough = 3777;
    samples[trough] = -3200;

    const out = decimateMinMax(samples, 1000);
    expect(Math.max(...out)).toBe(5000);
    expect(Math.min(...out)).toBe(-3200);
  });

  it("keeps the global peak even at a heavy reduction ratio", () => {
    const n = 9000;
    const samples = Array.from({ length: n }, (_, i) =>
      Math.round(Math.sin(i / 7) * 100),
    );
    samples[4500] = 999999; // single dominant peak
    const out = decimateMinMax(samples, 500);
    expect(Math.max(...out)).toBe(999999);
  });

  it("emits bucket extremes in index order so the trace shape is preserved", () => {
    // Rising-then-falling within the first bucket ⇒ min before max is wrong;
    // here index 0 is the min and index 2 the max, so min must come first.
    const samples = [0, 3, 9, 2, 8, 1, 7, 4];
    const out = decimateMinMax(samples, 4); // 2 buckets
    // First bucket [0..4): min=0 (idx0), max=9 (idx2) ⇒ 0 then 9.
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(9);
  });
});
