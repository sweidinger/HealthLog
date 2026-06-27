import { describe, it, expect } from "vitest";
import { detectLevelShift } from "@/lib/insights/derived/changepoint";

/** Deterministic pseudo-noise so the tests are stable. */
function noisy(base: number, n: number, seed: number): number[] {
  const out: number[] = [];
  let s = seed;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const jitter = ((s % 100) / 100 - 0.5) * 1.2; // ±0.6
    out.push(base + jitter);
  }
  return out;
}

describe("detectLevelShift", () => {
  it("detects a sustained step up", () => {
    const series = [...noisy(56, 25, 1), ...noisy(63, 25, 2)];
    const shift = detectLevelShift(series);
    expect(shift).not.toBeNull();
    expect(shift!.direction).toBe("up");
    // The break sits near the join (index ~24).
    expect(shift!.breakIndex).toBeGreaterThanOrEqual(20);
    expect(shift!.breakIndex).toBeLessThanOrEqual(28);
    expect(shift!.afterMean).toBeGreaterThan(shift!.beforeMean);
  });

  it("detects a sustained step down", () => {
    const series = [...noisy(70, 25, 3), ...noisy(60, 25, 4)];
    const shift = detectLevelShift(series);
    expect(shift).not.toBeNull();
    expect(shift!.direction).toBe("down");
  });

  it("does NOT fire on a noisy-but-flat series (no false fire)", () => {
    const series = noisy(58, 60, 5);
    expect(detectLevelShift(series)).toBeNull();
  });

  it("does NOT fire on a brief spike that does not persist", () => {
    // A flat run with a short late spike — the after-segment is too short to
    // persist, so the high firing bar rejects it.
    const series = [...noisy(58, 40, 6), 80, 81, 79];
    expect(detectLevelShift(series)).toBeNull();
  });

  it("does NOT fire on a too-short series", () => {
    expect(detectLevelShift([56, 56, 63, 63])).toBeNull();
  });

  it("does NOT fire on a perfectly flat series (zero spread)", () => {
    expect(detectLevelShift(new Array(40).fill(60))).toBeNull();
  });
});
