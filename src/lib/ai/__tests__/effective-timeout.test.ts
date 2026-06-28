import { describe, it, expect } from "vitest";
import { resolveEffectiveTimeoutMs } from "../effective-timeout";

const BUDGET = 120_000;

describe("resolveEffectiveTimeoutMs", () => {
  it("converts a positive per-user setting from seconds to ms", () => {
    expect(resolveEffectiveTimeoutMs(300, BUDGET)).toBe(300_000);
    expect(resolveEffectiveTimeoutMs(10, BUDGET)).toBe(10_000);
  });

  it("falls back to the budget default when the setting is unset", () => {
    expect(resolveEffectiveTimeoutMs(null, BUDGET)).toBe(BUDGET);
    expect(resolveEffectiveTimeoutMs(undefined, BUDGET)).toBe(BUDGET);
  });

  it("falls back to the budget default for a non-positive value", () => {
    expect(resolveEffectiveTimeoutMs(0, BUDGET)).toBe(BUDGET);
    expect(resolveEffectiveTimeoutMs(-5, BUDGET)).toBe(BUDGET);
  });

  it("honours different budget defaults per surface", () => {
    expect(resolveEffectiveTimeoutMs(null, 60_000)).toBe(60_000);
    expect(resolveEffectiveTimeoutMs(45, 60_000)).toBe(45_000);
  });
});
