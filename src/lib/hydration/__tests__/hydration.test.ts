import { describe, it, expect } from "vitest";

import {
  DEFAULT_HYDRATION_GOAL_ML,
  MAX_HYDRATION_GOAL_ML,
  MIN_HYDRATION_GOAL_ML,
  resolveHydrationGoal,
  summariseHydration,
} from "@/lib/hydration/hydration";

describe("resolveHydrationGoal", () => {
  it("falls back to the default when unset", () => {
    expect(resolveHydrationGoal(null)).toBe(DEFAULT_HYDRATION_GOAL_ML);
    expect(resolveHydrationGoal(undefined)).toBe(DEFAULT_HYDRATION_GOAL_ML);
    expect(resolveHydrationGoal(Number.NaN)).toBe(DEFAULT_HYDRATION_GOAL_ML);
  });

  it("clamps below the minimum", () => {
    expect(resolveHydrationGoal(10)).toBe(MIN_HYDRATION_GOAL_ML);
  });

  it("clamps above the maximum", () => {
    expect(resolveHydrationGoal(99999)).toBe(MAX_HYDRATION_GOAL_ML);
  });

  it("keeps an in-band value (rounded)", () => {
    expect(resolveHydrationGoal(2500.4)).toBe(2500);
  });
});

describe("summariseHydration", () => {
  it("empty day", () => {
    const s = summariseHydration(0, 2000);
    expect(s).toMatchObject({
      totalMl: 0,
      goalMl: 2000,
      percent: 0,
      rawPercent: 0,
      met: false,
      remainingMl: 2000,
    });
  });

  it("partial day", () => {
    const s = summariseHydration(1000, 2000);
    expect(s.percent).toBe(50);
    expect(s.rawPercent).toBe(50);
    expect(s.met).toBe(false);
    expect(s.remainingMl).toBe(1000);
  });

  it("goal met exactly", () => {
    const s = summariseHydration(2000, 2000);
    expect(s.percent).toBe(100);
    expect(s.met).toBe(true);
    expect(s.remainingMl).toBe(0);
  });

  it("exceeded — percent caps at 100, rawPercent does not", () => {
    const s = summariseHydration(2500, 2000);
    expect(s.percent).toBe(100);
    expect(s.rawPercent).toBe(125);
    expect(s.met).toBe(true);
    expect(s.remainingMl).toBe(0);
  });

  it("floors a negative total at zero", () => {
    const s = summariseHydration(-500, 2000);
    expect(s.totalMl).toBe(0);
    expect(s.met).toBe(false);
  });
});
