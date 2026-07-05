import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DashboardHeroSkeleton } from "../dashboard-hero-skeleton";

/**
 * Structural pin for the hero loading silhouette: the skeleton must
 * occupy the EXACT final footprint of `<DashboardHero>` (same min-h
 * floors, same md two-column split, same fixed 120 px ring circle) so
 * the loaded band swaps in place with zero layout shift — and it must
 * stay invisible to assistive tech with no focusable content.
 */
describe("<DashboardHeroSkeleton>", () => {
  const html = renderToStaticMarkup(<DashboardHeroSkeleton />);

  it("carries the data-slot and aria-hidden contract", () => {
    expect(html).toContain('data-slot="dashboard-hero-skeleton"');
    const root = html.match(
      /<div[^>]*data-slot="dashboard-hero-skeleton"[^>]*>/,
    );
    expect(root).not.toBeNull();
    expect(root![0]).toContain('aria-hidden="true"');
  });

  it("reserves the hero's exact footprint classes", () => {
    // v1.27.7 — the shell mirrors the loaded band's plain `bg-card`
    // surface (the old `hero-gradient` chrome was a leftover from the
    // pre-v1.18.1 gradient hero and never matched the loaded state).
    for (const cls of [
      "min-h-[8.75rem]",
      "md:min-h-[9.5rem]",
      "bg-card",
      "border-border",
      "rounded-xl",
    ]) {
      expect(html).toContain(cls);
    }
    expect(html).not.toContain("hero-gradient");
  });

  it("reserves no dose-row pill — the ring row replaced it (v1.27.7)", () => {
    // The left column carries exactly three skeleton bars (greeting +
    // verdict + CTA); the old fourth dose-pill bar is gone.
    const bars = html.match(/data-slot="skeleton"/g) ?? [];
    expect(bars.length).toBe(4); // 3 left-column bars + 1 ring circle
  });

  it("mirrors the two-column md:flex-row split with the fixed ring circle", () => {
    expect(html).toContain("md:flex-row");
    expect(html).toContain("size-[120px]");
    expect(html).toContain("rounded-full");
  });

  it("contains no focusable elements", () => {
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("tabindex");
  });
});
