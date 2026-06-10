import { describe, expect, it } from "vitest";

import { computePaddedYDomain } from "@/lib/insights/chart-y-domain";

describe("computePaddedYDomain", () => {
  it("returns undefined for an empty series", () => {
    expect(computePaddedYDomain([])).toBeUndefined();
  });

  it("ignores non-finite values", () => {
    expect(computePaddedYDomain([NaN, Infinity, -Infinity])).toBeUndefined();
  });

  it("clamps the lower bound to 0 for a non-negative series", () => {
    const domain = computePaddedYDomain([200, 450, 900]);
    expect(domain).toBeDefined();
    const [min, max] = domain!;
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeGreaterThan(900);
  });

  it("clamps to 0 when bottom padding would dip below 0 (steps-like series)", () => {
    // span 8800 → 8% bottom padding = 704 > min 200 → unclamped would be -504
    const domain = computePaddedYDomain([200, 9000]);
    expect(domain).toBeDefined();
    expect(domain![0]).toBe(0);
  });

  it("keeps downward padding for a series with genuine negative values", () => {
    const domain = computePaddedYDomain([-5, 3, 10]);
    expect(domain).toBeDefined();
    const [min, max] = domain!;
    expect(min).toBeLessThan(-5);
    expect(max).toBeGreaterThan(10);
  });

  it("pads a positive series without touching 0 when padding stays above it", () => {
    // span 2 → bottom padding max(0.16, 0.5) = 0.5 → 79.5, no clamp needed
    const domain = computePaddedYDomain([80, 82]);
    expect(domain).toBeDefined();
    expect(domain![0]).toBeCloseTo(79.5);
  });

  it("clamps a flat zero series to a [0, x] domain", () => {
    const domain = computePaddedYDomain([0, 0, 0]);
    expect(domain).toBeDefined();
    const [min, max] = domain!;
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(0);
  });

  it("keeps the symmetric flat-series padding for negative flat series", () => {
    const domain = computePaddedYDomain([-10, -10]);
    expect(domain).toBeDefined();
    expect(domain![0]).toBeLessThan(-10);
  });
});
