import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { InsightsPageHero } from "../insights-page-hero";

/**
 * v1.4.16 phase B1b — Apple-Health-style page hero.
 *
 * The /insights page entry-point gets a gradient hero shell:
 *  - h1 + subtitle (kept from the old layout, just polished)
 *  - "Generated <relative-time>" caption when an updatedAt is supplied
 *  - regenerate button when an onRegenerate handler is supplied
 *  - "Based on your last 90 days" personal-baseline indicator
 *  - smooth fade-in (CSS animation, gated by prefers-reduced-motion)
 *
 * The hero is a pure presentational shell; the page passes the values
 * in. This test pins the slot positions so a future polish pass can't
 * silently drop one (e.g. dropping the personal-baseline caption).
 */

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<InsightsPageHero>", () => {
  it("renders the heading + overview subtitle", () => {
    const html = render(<InsightsPageHero />);
    expect(html).toContain("Insights");
    expect(html).toContain("Trends, risks, progress at a glance");
  });

  it("paints a gradient background using Dracula tokens", () => {
    const html = render(<InsightsPageHero />);
    // The hero wrapper should carry a gradient + Dracula tokens so the
    // page header reads as the Apple-Health-style band.
    expect(html).toMatch(/data-slot="insights-page-hero"/);
    expect(html).toMatch(/bg-gradient-to/);
  });

  it("renders the personal-baseline caption", () => {
    const html = render(<InsightsPageHero />);
    expect(html).toContain("Based on your last 90 days");
  });

  it("renders the German personal-baseline caption", () => {
    const html = render(<InsightsPageHero />, "de");
    expect(html).toContain("Basierend auf deinen letzten 90 Tagen");
  });

  it("renders the generated-time caption when updatedAt is supplied", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const html = render(<InsightsPageHero updatedAt={fiveMinutesAgo} />);
    // Either "just now" / "5 minutes ago" / "vor 5 Minuten" — we just
    // assert the "Generated" label preceeds the relative-time string so
    // a future Intl.RelativeTimeFormat tweak can't dodge the slot.
    expect(html).toMatch(/data-slot="insights-page-hero-generated"/);
    expect(html).toContain("Generated");
  });

  it("does NOT render the generated caption when updatedAt is missing", () => {
    const html = render(<InsightsPageHero />);
    expect(html).not.toContain('data-slot="insights-page-hero-generated"');
  });

  it("renders a regenerate button when onRegenerate is supplied", () => {
    // The button is a real <button>, so SSR includes the markup verbatim.
    const html = render(<InsightsPageHero onRegenerate={() => {}} />);
    expect(html).toMatch(/data-slot="insights-page-hero-regenerate"/);
  });

  it("does NOT render the regenerate button when onRegenerate is missing", () => {
    const html = render(<InsightsPageHero />);
    expect(html).not.toContain('data-slot="insights-page-hero-regenerate"');
  });

  it("disables the regenerate button while regenerating", () => {
    const html = render(
      <InsightsPageHero onRegenerate={() => {}} regenerating />,
    );
    expect(html).toMatch(
      /data-slot="insights-page-hero-regenerate"[^>]*disabled/,
    );
  });

  it("German locale — heading + subtitle translate", () => {
    const html = render(<InsightsPageHero />, "de");
    // Reuses existing insights.title + insights.overviewSubtitle keys.
    // The "Insights" string is identical in DE so we assert the subtitle.
    expect(html).toContain("Trends, Risiken, Fortschritt auf einen Blick");
  });

  // ── B1b acceptance #6 — dark-mode contrast hygiene ────────────────
  it("uses high-enough gradient + border opacity to remain visible on dark bg", () => {
    const html = render(<InsightsPageHero />);
    // Border opacity must be >= 20% so it reads against the dark
    // background — `border-dracula-purple/20` or higher passes the
    // 3:1 contrast bar for a non-text UI element.
    expect(html).toMatch(/border-dracula-purple\/(2[0-9]|[3-9][0-9])/);
    // Gradient opacity must be at least /10 (we ship /10 + /5 on the
    // band; the cumulative effect on a dark bg renders as ~12% which
    // is the lower bound for visible band-vs-page differentiation).
    expect(html).toMatch(/from-dracula-purple\/(1[0-9]|[2-9][0-9])/);
  });
});
