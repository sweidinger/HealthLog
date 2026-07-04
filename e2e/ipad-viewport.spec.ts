import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * iPad-width regression guard (portrait, 768×1024).
 *
 * Two invariants this viewport class kept losing:
 *
 *   1. No horizontal page overflow — the content column must shrink
 *      below its children's intrinsic min width (`min-w-0` on the
 *      shell column); wide children scroll inside their own
 *      `overflow-x-auto` containers instead of widening the page.
 *   2. The content column keeps its room: with no stored sidebar
 *      preference, tablet widths start on the icon rail (w-16), so
 *      `<main>` gets ~704 px of the 768 — not the 512 px left over
 *      next to the expanded 256 px sidebar.
 *
 * Desktop project only — the assertions are viewport-driven via
 * `setViewportSize`, and the Pixel-5 project covers the phone class.
 */
const ROUTES = ["/", "/measurements", "/settings/integrations"] as const;

test.describe("iPad portrait layout (768x1024)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "viewport-driven spec; desktop project only",
    );
  });

  for (const route of ROUTES) {
    test(`no horizontal overflow and full-width content on ${route}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      const dims = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
        mainWidth:
          document
            .querySelector("main")
            ?.getBoundingClientRect()
            .width.valueOf() ?? 0,
      }));

      // 1 px tolerance for sub-pixel rounding, matching the Pixel-5 spec.
      expect(
        dims.scrollWidth,
        `page scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
      ).toBeLessThanOrEqual(dims.innerWidth + 1);
      expect(
        dims.bodyScrollWidth,
        `body scrollWidth=${dims.bodyScrollWidth}`,
      ).toBeLessThanOrEqual(dims.innerWidth + 1);

      // Icon rail (64 px) + content: main must keep ≥ 690 px of the 768.
      expect(
        Math.round(dims.mainWidth),
        `main width=${dims.mainWidth}`,
      ).toBeGreaterThanOrEqual(690);
    });
  }
});
