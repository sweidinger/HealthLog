import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Vertical over-scroll regression guard (the recurring class behind the
 * v1.25.11 settings fix): the scroll viewport must never extend far past
 * the last content element. The rule the guard pins is structural — only
 * the AuthShell owns the scroll height and the bottom padding
 * (`pt-6 pb-20` on the wrapper, plus the `<md` bottom-nav clearance on
 * `<main>`); a page/section must never add its own viewport-height
 * reserve or bottom gutter, because every such nested reserve stacks on
 * the shell's own budget and reopens the dark-band-below-the-last-card
 * bug.
 *
 * The assertion: `main.scrollHeight` ≤ bottom edge of the lowest content
 * element + the shell-owned padding + tolerance. Runs across the
 * settings routes (short hub, long sortable-list subpages, long form
 * section) at desktop AND phone-shaped viewports, because the two shell
 * paddings differ per breakpoint.
 */
const ROUTES = [
  "/settings/layout",
  "/settings/layout/dashboard",
  "/settings/layout/insights",
  "/settings/account",
  "/settings/notifications",
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, expectedPad: 80 }, // wrapper pb-20
  { name: "phone", width: 390, height: 844, expectedPad: 144 }, // pb-20 + main pb-16
] as const;

test.describe("settings vertical over-scroll guard", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven spec; desktop project only",
    );
  });

  for (const vp of VIEWPORTS) {
    for (const route of ROUTES) {
      test(`no over-scroll on ${route} (${vp.name})`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle");
        // Let entry transitions / late queries settle before measuring.
        await page.waitForTimeout(500);

        const dims = await page.evaluate(() => {
          const main = document.getElementById("main-content");
          if (!main) return null;
          const wrapper = main.firstElementChild as HTMLElement | null;
          if (!wrapper) return null;
          // Lowest content edge: max bottom over the wrapper's visible,
          // non-fixed descendants, in the scroll container's coordinate
          // space. Elements inside nested scroll containers are clipped
          // by their own overflow and never add page scroll height, so
          // skip anything whose scrollable ancestor is not `main`.
          let maxBottom = 0;
          const mainTop = main.getBoundingClientRect().top;
          for (const el of wrapper.querySelectorAll<HTMLElement>("*")) {
            const cs = getComputedStyle(el);
            if (cs.position === "fixed") continue;
            const rect = el.getBoundingClientRect();
            if (rect.height === 0 && rect.width === 0) continue;
            // Skip descendants of inner scroll containers (their
            // overflow does not contribute to the page scroll height).
            let p = el.parentElement;
            let inner = false;
            while (p && p !== main) {
              const pcs = getComputedStyle(p);
              if (
                (pcs.overflowY === "auto" || pcs.overflowY === "scroll") &&
                p.scrollHeight > p.clientHeight
              ) {
                inner = true;
                break;
              }
              p = p.parentElement;
            }
            if (inner) continue;
            const bottom = rect.bottom + main.scrollTop - mainTop;
            if (bottom > maxBottom) maxBottom = bottom;
          }
          return {
            scrollHeight: main.scrollHeight,
            clientHeight: main.clientHeight,
            contentBottom: Math.round(maxBottom),
          };
        });

        expect(dims, "main-content / wrapper present").not.toBeNull();
        if (!dims) return;

        // A page shorter than the viewport cannot over-scroll at all.
        if (dims.scrollHeight <= dims.clientHeight) return;

        const tolerance = 24;
        expect(
          dims.scrollHeight,
          `scrollHeight=${dims.scrollHeight} contentBottom=${dims.contentBottom} ` +
            `expectedPad=${vp.expectedPad} — the scroll area extends past the ` +
            `last content element + the shell-owned padding; some nested ` +
            `min-h / bottom padding is stacking on the shell budget`,
        ).toBeLessThanOrEqual(dims.contentBottom + vp.expectedPad + tolerance);
      });
    }
  }
});
