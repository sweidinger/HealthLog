import { describe, expect, it } from "vitest";

import { computeTooltipPosition } from "../tour";

/**
 * Pure-function contract tests for the tour popover position resolver.
 *
 * Production regression (v1.16.2): step 4 anchored to a nav item below
 * the fold and the resolved position put the whole card under the
 * viewport bottom — the Next button was unreachable and the tour was
 * stuck. The resolver now guarantees: every anchored placement keeps
 * the card's bottom edge ≥ 8 px above the viewport bottom, vertical
 * fallbacks prefer ABOVE the target, and an off-screen target (or a
 * target with no fitting placement at all) resolves to the `"sheet"`
 * fallback on every viewport width.
 */

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = { width: 320, height: 220 };
const PAD = 8;

function expectInsideViewport(pos: { top: number; left: number }) {
  expect(pos.top).toBeGreaterThanOrEqual(PAD);
  expect(pos.left).toBeGreaterThanOrEqual(PAD);
  expect(pos.top + SIZE.height).toBeLessThanOrEqual(VIEWPORT.height - PAD);
  expect(pos.left + SIZE.width).toBeLessThanOrEqual(VIEWPORT.width - PAD);
}

describe("computeTooltipPosition", () => {
  it("returns a centred placement when there is no target rect", () => {
    const pos = computeTooltipPosition(null, "bottom", SIZE, VIEWPORT);
    expect(pos.placement).toBe("center");
    expectInsideViewport(pos);
  });

  it("keeps the requested bottom placement when it fits", () => {
    const rect = { top: 100, left: 400, width: 200, height: 48 };
    const pos = computeTooltipPosition(rect, "bottom", SIZE, VIEWPORT);
    expect(pos.placement).toBe("bottom");
    expect(pos.top).toBeGreaterThan(rect.top + rect.height);
    expectInsideViewport(pos);
  });

  it("flips a bottom placement ABOVE a target low in the viewport", () => {
    // Target visible but near the bottom edge: below it there is no
    // room for a 220 px card, above it there is.
    const rect = { top: 700, left: 400, width: 200, height: 48 };
    const pos = computeTooltipPosition(rect, "bottom", SIZE, VIEWPORT);
    expect(pos.placement).toBe("top");
    expect(pos.top + SIZE.height).toBeLessThanOrEqual(rect.top);
    expectInsideViewport(pos);
  });

  it("resolves to the sheet fallback when the target sits below the fold", () => {
    // The production bug: an anchor entirely under the viewport bottom.
    const rect = { top: 900, left: 16, width: 200, height: 48 };
    const pos = computeTooltipPosition(rect, "right", SIZE, VIEWPORT);
    expect(pos.placement).toBe("sheet");
  });

  it("resolves to the sheet fallback when the target sits above the viewport", () => {
    const rect = { top: -300, left: 16, width: 200, height: 48 };
    const pos = computeTooltipPosition(rect, "bottom", SIZE, VIEWPORT);
    expect(pos.placement).toBe("sheet");
  });

  it("falls back from a side placement to the vertical axis when neither side fits", () => {
    // Target spans nearly the full width: no room left or right, but
    // room above — the resolver must not clamp the card over the
    // target or below the fold.
    const rect = { top: 600, left: 8, width: 1264, height: 60 };
    const pos = computeTooltipPosition(rect, "right", SIZE, VIEWPORT);
    expect(pos.placement).toBe("top");
    expect(pos.top + SIZE.height).toBeLessThanOrEqual(rect.top);
    expectInsideViewport(pos);
  });

  it("resolves to the sheet fallback when no candidate fits anywhere", () => {
    // Target covers essentially the whole viewport — every anchored
    // candidate would land outside.
    const rect = { top: 8, left: 8, width: 1264, height: 784 };
    const pos = computeTooltipPosition(rect, "bottom", SIZE, VIEWPORT);
    expect(pos.placement).toBe("sheet");
  });

  it("keeps the card bottom edge ≥ 8px above the viewport bottom for every anchored result", () => {
    const placements = ["top", "bottom", "left", "right", "center"] as const;
    for (const placement of placements) {
      for (let top = -200; top <= 1000; top += 40) {
        const rect = { top, left: 480, width: 200, height: 48 };
        const pos = computeTooltipPosition(rect, placement, SIZE, VIEWPORT);
        if (pos.placement === "sheet") continue; // sheet pins itself via CSS
        expect(pos.top + SIZE.height).toBeLessThanOrEqual(
          VIEWPORT.height - PAD,
        );
        expect(pos.top).toBeGreaterThanOrEqual(PAD);
      }
    }
  });
});
