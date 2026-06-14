/**
 * v1.17.1 — the "Reminders & Notifications" hub.
 *
 * The hub is the single front door for every reminder concept. It groups the
 * reminder CATEGORIES (medication / Vorsorge / mood / low-stock / coach) and
 * links to the notification CHANNELS, with each link deep-linking into the
 * canonical editor so nothing is rewritten — only gathered in one place.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { RemindersSection } from "../reminders-section";

function render(locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <RemindersSection />
    </I18nProvider>,
  );
}

describe("<RemindersSection>", () => {
  it("deep-links to every canonical reminder editor", () => {
    const html = render();
    for (const href of [
      "/medications",
      "/vorsorge",
      "/settings/notifications#mood-reminder",
      "/settings/notifications#low-stock",
      "/settings/notifications#coach-nudge",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("links to the notification channels screen (the how/where)", () => {
    const html = render();
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('data-testid="reminders-link-channels"');
  });

  it("renders a card for each reminder category", () => {
    const html = render();
    for (const testId of [
      "reminders-link-medication",
      "reminders-link-vorsorge",
      "reminders-link-mood",
      "reminders-link-low-stock",
      "reminders-link-coach",
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
  });

  it("separates categories (what/when) from channels (how/where)", () => {
    const html = render();
    expect(html).toContain("Reminders");
    expect(html).toContain("Delivery channels");
  });

  it("resolves its copy in German too", () => {
    const html = render("de");
    expect(html).toContain("Medikamenten-Erinnerungen");
    expect(html).toContain("Zustellkanäle");
  });
});
