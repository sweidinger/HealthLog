import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MoodHeatmap } from "../mood-heatmap";

/**
 * 2026-07-17 a11y audit (M2) — mood heatmap day cells were pointer-only
 * SVG `<rect>`s: no `tabIndex`, no per-day `aria-label`. This pins the
 * keyboard-reachability fix (each cell focusable + self-describing) on
 * top of the pre-existing aggregate `role="img"` summary on the SVG.
 */
function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodHeatmap
        cells={{
          "2026-01-05": { date: "2026-01-05", score: 4.2, samples: 2 },
        }}
        days={14}
      />
    </I18nProvider>,
  );
}

describe("<MoodHeatmap> — keyboard-reachable day cells", () => {
  it("keeps the aggregate role=img summary on the SVG", () => {
    const html = render();
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="[^"]+"/);
  });

  it("makes every day cell focusable with its own aria-label", () => {
    const html = render();
    const rectMatches = html.match(/<rect\b[^>]*>/g) ?? [];
    expect(rectMatches.length).toBeGreaterThan(0);
    for (const rect of rectMatches) {
      expect(rect).toContain('tabindex="0"');
      expect(rect).toContain('role="img"');
      expect(rect).toMatch(/aria-label="[^"]+"/);
    }
  });
});
