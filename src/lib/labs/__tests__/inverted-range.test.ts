/**
 * v1.18.1 — partial-update inverted-range merge guard.
 *
 * The lab + biomarker PUT routes merge a parsed bound against the row's stored
 * bound before checking low ≤ high, so a single-bound edit cannot persist a
 * transposed range that the schema-level refine (which only fires when both
 * bounds arrive together) would miss.
 */
import { describe, expect, it } from "vitest";

import { effectiveBound, isInvertedRange } from "@/lib/validations/labs";

describe("effectiveBound", () => {
  it("prefers the parsed value when present", () => {
    expect(effectiveBound(50, 10)).toBe(50);
  });

  it("uses an explicit null parsed value (clearing the bound)", () => {
    expect(effectiveBound(null, 10)).toBeNull();
  });

  it("falls back to the stored value when the field is omitted", () => {
    expect(effectiveBound(undefined, 10)).toBe(10);
    expect(effectiveBound(undefined, null)).toBeNull();
  });
});

describe("isInvertedRange", () => {
  it("flags low > high", () => {
    expect(isInvertedRange(120, 100)).toBe(true);
  });

  it("accepts low == high (inclusive bounds)", () => {
    expect(isInvertedRange(100, 100)).toBe(false);
  });

  it("accepts a normal range", () => {
    expect(isInvertedRange(40, 100)).toBe(false);
  });

  it("ignores an open-ended range (one bound null)", () => {
    expect(isInvertedRange(null, 100)).toBe(false);
    expect(isInvertedRange(40, null)).toBe(false);
    expect(isInvertedRange(null, null)).toBe(false);
  });

  it("catches the partial-update case: new low above the stored high", () => {
    // PUT sets referenceLow=130 on a row whose stored referenceHigh=116.
    const low = effectiveBound(130, null);
    const high = effectiveBound(undefined, 116);
    expect(isInvertedRange(low, high)).toBe(true);
  });

  it("catches the partial-update case: new high below the stored low", () => {
    const low = effectiveBound(undefined, 40);
    const high = effectiveBound(20, null);
    expect(isInvertedRange(low, high)).toBe(true);
  });
});
