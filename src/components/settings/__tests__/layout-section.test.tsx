/**
 * v1.17.1 (F-2) — the "Layout & Personalization" hub.
 *
 * The hub is the single front door for the four personalization editors.
 * It must link to each of them with consistent framing so the concept
 * reads as one home rather than four scattered settings sections.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { LayoutSection } from "../layout-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <LayoutSection />
    </I18nProvider>,
  );
}

describe("<LayoutSection>", () => {
  it("links to the arrangement editors it still hosts", () => {
    const html = render();
    for (const href of ["/settings/dashboard", "/settings/insights"]) {
      expect(html).toContain(`href="${href}"`);
    }
    // v1.18.0 (S5) — Medications (Medikamente) and Mood (Stimmung)
    // graduated to their own nav entries and are no longer linked here.
    expect(html).not.toContain('href="/settings/medications"');
    expect(html).not.toContain('href="/settings/mood"');
  });

  it("renders the hub heading and a card per editor", () => {
    const html = render();
    expect(html).toContain("Dashboard");
    expect(html).toContain("Insights");
  });

  it("resolves its copy in German too", () => {
    const html = render("de");
    expect(html).toContain("Layout");
    expect(html).not.toContain("settings.sections.layout.");
  });
});
