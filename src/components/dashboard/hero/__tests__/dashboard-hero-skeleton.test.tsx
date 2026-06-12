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
    for (const cls of [
      "min-h-[8.75rem]",
      "md:min-h-[9.5rem]",
      "hero-gradient",
      "rounded-xl",
    ]) {
      expect(html).toContain(cls);
    }
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
