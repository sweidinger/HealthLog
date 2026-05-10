import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { SourcesRail } from "../sources-rail";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<SourcesRail>", () => {
  it("renders the rail wrapper + label", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain('data-slot="coach-sources-rail"');
    expect(html).toContain("What I can see");
  });

  it("lists exactly five rows (BP, weight, pulse, mood, compliance)", () => {
    const html = render(<SourcesRail />);
    const rows = html.match(/data-slot="coach-sources-row"/g) ?? [];
    expect(rows.length).toBe(5);
    expect(html).toContain('data-source="bp"');
    expect(html).toContain('data-source="weight"');
    expect(html).toContain('data-source="pulse"');
    expect(html).toContain('data-source="mood"');
    expect(html).toContain('data-source="compliance"');
  });

  it("renders the localised metric labels in English", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain("Blood pressure");
    expect(html).toContain("Weight");
    expect(html).toContain("Pulse");
    expect(html).toContain("Mood");
    expect(html).toContain("Compliance");
  });

  it("renders the German labels when locale is 'de'", () => {
    const html = render(<SourcesRail />, "de");
    expect(html).toContain("Blutdruck");
    expect(html).toContain("Gewicht");
    expect(html).toContain("Einnahmetreue");
  });

  it("renders the footer disclaimer", () => {
    const html = render(<SourcesRail />);
    expect(html).toContain(
      "The Coach reads only the data you&#x27;ve connected.",
    );
  });
});
