import { describe, expect, it } from "vitest";

import { chooseTickInterval, resolveTargetTickCount } from "../x-axis-density";

describe("resolveTargetTickCount", () => {
  it("caps Galaxy Fold compact (≤360px) at 4 ticks", () => {
    expect(resolveTargetTickCount(280)).toBe(4);
    expect(resolveTargetTickCount(360)).toBe(4);
  });

  it("caps Pixel 5 / iPhone 12 (≤480px) at 6 ticks", () => {
    expect(resolveTargetTickCount(361)).toBe(6);
    expect(resolveTargetTickCount(390)).toBe(6);
    expect(resolveTargetTickCount(393)).toBe(6);
    expect(resolveTargetTickCount(480)).toBe(6);
  });

  it("caps small tablet (≤768px) at 8 ticks", () => {
    expect(resolveTargetTickCount(481)).toBe(8);
    expect(resolveTargetTickCount(768)).toBe(8);
  });

  it("caps desktop (>768px) at 10 ticks", () => {
    expect(resolveTargetTickCount(1024)).toBe(10);
    expect(resolveTargetTickCount(1920)).toBe(10);
  });

  it("falls back to desktop default for invalid input", () => {
    expect(resolveTargetTickCount(0)).toBe(10);
    expect(resolveTargetTickCount(-100)).toBe(10);
    expect(resolveTargetTickCount(Number.NaN)).toBe(10);
  });
});

describe("chooseTickInterval", () => {
  it("returns 0 when point count fits in target", () => {
    // Pixel 5 (393) → max 6 ticks. 7 points still fits because
    // preserveStartEnd doesn't multiply our cap.
    expect(chooseTickInterval(0, 393)).toBe(0);
    expect(chooseTickInterval(3, 393)).toBe(0);
    expect(chooseTickInterval(6, 393)).toBe(0);
  });

  it("medication chart 30-day window on Pixel 5 → ≤6 visible ticks", () => {
    // 30 daily points capped to 6 visible → interval = ceil(30/6)-1 = 4
    // Recharts then shows the first, last, and every 5th in between.
    const interval = chooseTickInterval(30, 393);
    expect(interval).toBe(4);
    // Sanity: stepping every 5th index from 0 over 30 lands on
    // 0, 5, 10, 15, 20, 25, 29 → 6 + endpoints (preserveStartEnd
    // keeps the right edge).
    const stepped = Math.ceil(30 / (interval + 1));
    expect(stepped).toBeLessThanOrEqual(6);
  });

  it("90-day window on Pixel 5 → ≤6 visible ticks", () => {
    const interval = chooseTickInterval(90, 393);
    expect(Math.ceil(90 / (interval + 1))).toBeLessThanOrEqual(6);
  });

  it("365-day window on Pixel 5 still ≤6 ticks", () => {
    const interval = chooseTickInterval(365, 393);
    expect(Math.ceil(365 / (interval + 1))).toBeLessThanOrEqual(6);
  });

  it("Galaxy Fold compact (280px) caps at 4 visible ticks", () => {
    const interval = chooseTickInterval(30, 280);
    expect(Math.ceil(30 / (interval + 1))).toBeLessThanOrEqual(4);
  });

  it("desktop 1280px shows up to 10 ticks", () => {
    const interval = chooseTickInterval(30, 1280);
    expect(Math.ceil(30 / (interval + 1))).toBeLessThanOrEqual(10);
  });

  it("returns 0 for invalid point count", () => {
    expect(chooseTickInterval(0, 393)).toBe(0);
    expect(chooseTickInterval(-1, 393)).toBe(0);
    expect(chooseTickInterval(Number.NaN, 393)).toBe(0);
  });

  it("never returns a negative interval", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 100]) {
      for (const w of [200, 300, 393, 768, 1280, 1920]) {
        expect(chooseTickInterval(n, w)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
