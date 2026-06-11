import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { MoodTagBreakdown } from "../mood-tag-breakdown";
import { MoodStructuredTagBreakdown } from "../mood-structured-tag-breakdown";

/**
 * v1.16.8 — the tag-breakdown bars carry the same muted treatment as
 * the mood Recharts charts (`fillOpacity={0.55}` on distribution /
 * weekday / time-of-day). The CSS bars rendered the raw `--dracula-*`
 * hues at full opacity, which made the two tag cards shout next to the
 * matte charts above them. Pinned: every fill bar ships `opacity-55`.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("mood tag bars — muted palette (v1.16.8)", () => {
  it("free-text tag breakdown bars render at the shared chart opacity", () => {
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
      expect(fill).toContain("opacity-55");
    }
    // The level hue itself stays a Dracula token.
    expect(html).toContain("var(--dracula-red)");
    expect(html).toContain("var(--dracula-green)");
  });

  it("structured tag breakdown bars render at the shared chart opacity", () => {
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
    expect(fills?.[0]).toContain("opacity-55");
  });
});
