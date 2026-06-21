import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MoodTagBreakdown } from "../mood-tag-breakdown";
import { MoodStructuredTagBreakdown } from "../mood-structured-tag-breakdown";

/**
 * v1.19.0 — the muted mood treatment (`opacity-55` on the tag bars,
 * `fillOpacity={0.55}` on the Recharts bars) read as a rendering glitch,
 * so the bars now paint at full saturation in their level hue. This guard
 * keeps the dimming from creeping back: every fill bar carries the level
 * colour at full opacity.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("mood tag bars — full-saturation palette (v1.19.0)", () => {
  it("free-text tag breakdown bars render at full opacity", () => {
    const html = render(
      <MoodTagBreakdown
        tags={[
          { tag: "stress", count: 6, avgScore: 1.8 },
          { tag: "sport", count: 4, avgScore: 4.2 },
        ]}
      />,
    );
    const fills = html.match(/class="[^"]*absolute inset-y-0 left-0[^"]*"/g);
    expect(fills).toHaveLength(2);
    for (const fill of fills ?? []) {
      expect(fill).not.toContain("opacity-55");
    }
    // The level hue itself stays a Dracula token.
    expect(html).toContain("var(--dracula-red)");
    expect(html).toContain("var(--dracula-green)");
  });

  it("structured tag breakdown bars render at full opacity", () => {
    const html = render(
      <MoodStructuredTagBreakdown
        tags={[
          {
            key: "social.friends",
            categoryKey: "social",
            labelKey: "mood.tags.friends",
            icon: null,
            count: 3,
            avgScore: 3.9,
          },
        ]}
      />,
    );
    const fills = html.match(/class="[^"]*absolute inset-y-0 left-0[^"]*"/g);
    expect(fills).toHaveLength(1);
    expect(fills?.[0]).not.toContain("opacity-55");
  });
});
