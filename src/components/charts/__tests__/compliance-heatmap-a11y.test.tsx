import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ComplianceHeatmap } from "../compliance-heatmap";

/**
 * 2026-07-17 a11y audit (M2) — medication-compliance heatmap day cells are
 * pointer-only SVG `<rect>`s. The keyboard/screen-reader path to the
 * per-day values is a visually-hidden day list beside the grid, not
 * focusable rects (a cell subtree nested under the SVG's `role="img"` is
 * pruned from the a11y tree, and per-cell tab stops would flood the
 * keyboard order). This pins that list plus the aggregate `role="img"`
 * summary, and that the rects stay a pure pointer affordance.
 */
// The grid window is the last `days` days ending today, so seed relative
// dates (UTC-sliced, matching the component) rather than fixed ones that
// would slide out of the window over time.
const dayKey = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const D0 = dayKey(0);
const D1 = dayKey(1);

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <ComplianceHeatmap
        dailyCompliance={{
          [D0]: { expected: 2, taken: 2, skipped: 0 },
          [D1]: { expected: 2, taken: 1, skipped: 1 },
        }}
        days={14}
      />
    </I18nProvider>,
  );
}

describe("<ComplianceHeatmap> — keyboard-reachable day values", () => {
  it("keeps the aggregate role=img summary on the SVG", () => {
    const html = render();
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]+"/);
  });

  it("keeps the day cells a pure pointer affordance (no tab stops)", () => {
    const html = render();
    const rectMatches = html.match(/<rect\b[^>]*>/g) ?? [];
    expect(rectMatches.length).toBeGreaterThan(0);
    for (const rect of rectMatches) {
      expect(rect).not.toContain("tabindex");
    }
  });

  it("exposes each active day through a visually-hidden day list", () => {
    const html = render();
    // The sr-only list carries one entry per day that had a scheduled or
    // taken dose — here the two seeded days.
    const listMatch = html.match(
      /<ul[^>]*data-slot="compliance-heatmap-day-list"[^>]*>([\s\S]*?)<\/ul>/,
    );
    expect(listMatch).not.toBeNull();
    const items = listMatch![1].match(/<li[^>]*>/g) ?? [];
    expect(items.length).toBe(2);
    // Each entry pairs the day with its taken/expected + rate string.
    expect(listMatch![1]).toContain("2/2 (100%)");
    expect(listMatch![1]).toContain("1/2 (50%)");
  });
});
