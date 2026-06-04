/**
 * Arztbericht (doctor-report) card contract.
 *
 * v1.4.37 W7a promoted this surface to the page hero; v1.12 demotes it
 * back to a small secondary card at the bottom of `/settings/export`
 * (the health-record export now owns the hero). The card stays fully
 * functional — only the framing and visual weight changed. This suite
 * pins the SSR contract:
 *
 *   1. The card renders with the expected `data-testid` slot.
 *   2. The value statement is present (Marc-Voice copy, no AI mention).
 *   3. The CTA button is present, clears the 44 px touch floor, and
 *      carries an `aria-describedby` link to the value statement.
 *   4. The CTA is wired to a click handler (the prop `data-testid`
 *      surface is the e2e contract).
 *   5. Both DE and EN locales resolve their copy without leaking the
 *      raw i18n key.
 *
 * Project convention is SSR-only tests (no `@testing-library/react`).
 * The actual click-flow + PDF generation is exercised by the e2e
 * Playwright path and the dialog's own integration tests.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ArztberichtHeroCard } from "../arztbericht-hero-card";

function renderSSR(node: React.ReactElement, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<ArztberichtHeroCard> — SSR contract", () => {
  it("renders the card slot with eyebrow + title", () => {
    const html = renderSSR(<ArztberichtHeroCard />);
    expect(html).toContain('data-testid="export-hero-doctor-report"');
    // Title falls back to the existing doctorReport.title key — keeps
    // a single source-of-truth for the brand name.
    expect(html).toContain("Doctor Report");
    // Eyebrow surfaces the use-case framing.
    expect(html).toContain("Doctor visit");
  });

  it("renders the value statement as a Marc-Voice one-liner", () => {
    const html = renderSSR(<ArztberichtHeroCard />);
    expect(html).toContain('data-testid="export-hero-doctor-report-value"');
    expect(html).toContain("printable PDF report");
    // No AI/Coach name-drop in the user-facing artefact (Marc-Voice).
    expect(html.toLowerCase()).not.toContain("coach");
    expect(html.toLowerCase()).not.toContain(" ai ");
  });

  it("renders the CTA with min-h-11 touch target + aria-describedby", () => {
    const html = renderSSR(<ArztberichtHeroCard />);
    expect(html).toContain('data-testid="export-hero-doctor-report-action"');
    // 44 px touch floor (WCAG 2.5.5) — the demoted CTA keeps `min-h-11`
    // on mobile and falls back to the compact `sm:min-h-9` on pointer
    // devices.
    expect(html).toContain("min-h-11");
    // Aria-describedby links the CTA to the value statement so screen
    // readers announce the framing alongside the action label.
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  it("does NOT leak raw i18n keys", () => {
    const html = renderSSR(<ArztberichtHeroCard />);
    expect(html).not.toContain("settings.sections.export.hero");
    expect(html).not.toContain("settings.sections.export.cards.doctorReport");
  });

  it("renders German copy when the DE locale is active", () => {
    const html = renderSSR(<ArztberichtHeroCard />, "de");
    expect(html).toContain("Arztbericht");
    expect(html).toContain("Arzttermin");
    // Umlauts encoded as their literal UTF-8 character (not their HTML
    // entity), matching the rest of the codebase.
    expect(html).toContain("druckbarer PDF-Bericht");
    expect(html).not.toContain("settings.sections.export.hero");
  });

  it("renders as a plain secondary card, not a hero", () => {
    const html = renderSSR(<ArztberichtHeroCard />);
    // v1.12 demoted the doctor-report from the page hero — the
    // health-record export now owns the hero treatment, so this card
    // must NOT carry the hero gradient/glow utilities.
    expect(html).not.toContain("hero-gradient");
    expect(html).not.toContain("glow-purple");
    // It renders with the standard secondary-card surface.
    expect(html).toContain("bg-card");
  });

  it("does not paint dialog markup in the closed-state SSR pass", () => {
    // Radix Dialog renders its portal content lazily, so the closed
    // SSR pass never carries `role="dialog"`. The CTA testid IS
    // present so the e2e suite can drive the open from there. Pinning
    // this contract guards against an accidental `defaultOpen={true}`
    // regression that would briefly paint the dialog above the page on
    // every cold mount.
    const html = renderSSR(<ArztberichtHeroCard />);
    expect(html).toContain('data-testid="export-hero-doctor-report-action"');
    expect(html).not.toContain('role="dialog"');
  });
});

describe("<ArztberichtHeroCard> — heading hierarchy", () => {
  it("uses an <h2> so it nests cleanly below the page-level <h1>", () => {
    const html = renderSSR(<ArztberichtHeroCard />);
    // Page-level h1 (settings-section-export-title) wraps the section;
    // hero owns the h2 slot. The export-section test pins the outer
    // h1; this assertion pins the hero's contribution.
    expect(html).toMatch(/<h2[^>]*id="export-hero-doctor-report-title"/);
  });
});
