/**
 * v1.17.1 (F-2) — the "Appearance" hub (slug stays `layout`).
 *
 * The hub is the single front door for every view/arrangement surface. It must
 * link to each with consistent framing so "how my app looks" reads as one home
 * rather than scattered settings sections.
 *
 * v1.25.3 — the hub widened from 2 links (dashboard + insights) to 6: it now
 * also deep-links to the view/sort/order cards of medications, labs, the
 * illness journal, and checkups. Those cards stay on their own module pages;
 * the hub only indexes them via anchor deep-links.
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
  it("links to every view surface it indexes (anchor deep-links)", () => {
    const html = render();
    for (const href of [
      "/settings/dashboard",
      "/settings/insights",
      "/settings/medications#medications-view",
      "/settings/labs#labs-view",
      "/settings/illness#illness-view",
      "/settings/vorsorge#vorsorge-view",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("renders one card per indexed surface (6 links)", () => {
    const html = render();
    // Pin the link count: every hub card is an `<a href="/settings/…">`.
    const links = html.match(/href="\/settings\//g) ?? [];
    expect(links.length).toBe(6);
    expect(html).toContain("Dashboard");
    expect(html).toContain("Insights");
  });

  it("resolves its copy in German too", () => {
    const html = render("de");
    // The hub body is the link list; the German module labels resolve.
    expect(html).toContain("Medikamente");
    expect(html).toContain("Labor");
    expect(html).not.toContain("settings.sections.layout.");
  });
});
