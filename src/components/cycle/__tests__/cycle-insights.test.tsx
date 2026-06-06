import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CycleInsights } from "../cycle-insights";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<CycleInsights>", () => {
  it("renders the empty-state when no cards are surfaced", () => {
    const html = render(<CycleInsights cards={[]} />);
    expect(html).toContain("Phase insights appear here");
    expect(html).not.toContain('data-slot="cycle-insights"');
  });

  it("renders the card list with the open statistics when cards are present", () => {
    const html = render(
      <CycleInsights
        cards={[
          {
            id: "rhr-luteal",
            title: "Resting heart rate runs higher in your luteal phase",
            body: "Across your logged cycles RHR is ~3 bpm higher in luteal vs follicular days.",
            n: 42,
            effectSize: 0.61,
            qValue: 0.04,
            caveat: "Descriptive only.",
          },
        ]}
      />,
    );
    expect(html).toContain('data-slot="cycle-insights"');
    expect(html).toContain("Resting heart rate runs higher");
    expect(html).toContain("n = 42");
    expect(html).toContain("0.61");
    expect(html).toContain("0.040");
    expect(html).toContain("Descriptive only.");
  });
});
