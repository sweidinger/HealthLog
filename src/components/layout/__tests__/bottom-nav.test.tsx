/**
 * v1.4.16 Wave-C MED — bottom-nav 5+More layout.
 *
 * SSR contract for `<BottomNav>`:
 *   - exactly five primary links + one "More" button render in the strip
 *   - the More button is keyboard-reachable as a `<button>` with
 *     `aria-haspopup="dialog"`
 *   - Targets + Achievements live in the More sheet (closed by default
 *     under SSR), not in the always-visible strip
 *   - WCAG 2.5.5 floor: every entry is `min-h-11 min-w-11`
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// `<BottomNav>` reads the active route from `usePathname()`. Stub
// next/navigation so the SSR render works without an App-Router runtime.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { BottomNav } from "../bottom-nav";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BottomNav />
    </I18nProvider>,
  );
}

describe("<BottomNav> 5+More layout", () => {
  it("renders the five primary anchors", () => {
    const html = render();
    for (const href of [
      "/",
      "/measurements",
      "/mood",
      "/medications",
      "/insights",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("renders an overflow More button via aria-haspopup", () => {
    const html = render();
    expect(html).toContain('data-testid="bottom-nav-more"');
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("each primary entry meets the 44 px tap-target floor (min-h-11 min-w-11)", () => {
    const html = render();
    // Count `min-h-11 min-w-11` occurrences. Six is the expected floor
    // (five anchors + the More button); we don't hard-pin because a
    // future entry would also satisfy the contract.
    const matches = html.match(/min-h-11 min-w-11/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it("More button carries an accessible label", () => {
    const html = render();
    // Attribute order isn't guaranteed by React's renderer, so match
    // both possible directions instead of pinning the order.
    const hasLabelFirst = /aria-label="More"[^>]*data-testid="bottom-nav-more"/.test(
      html,
    );
    const hasTestidFirst = /data-testid="bottom-nav-more"[^>]*aria-label="More"/.test(
      html,
    );
    expect(hasLabelFirst || hasTestidFirst).toBe(true);
  });
});
