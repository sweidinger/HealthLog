import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 A3 — `/admin/api-tokens` must not produce horizontal page
 * overflow on a Pixel-5 viewport (393 CSS px). v1.4.15 added column-
 * hide breakpoints + tighter card padding, but Marc still saw a
 * scrollbar on prod. The v1.4.16 fix swaps the desktop `<table>` for a
 * mobile card-list at <md, mirroring `<UserManagementSection>`.
 *
 * Mobile-only spec — the desktop project skips it.
 */
test.describe("/admin/api-tokens mobile no-overflow", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium-mobile", "mobile-only spec");
  });

  test("Pixel-5 viewport: no horizontal page scroll on /admin/api-tokens", async ({
    page,
  }) => {
    // Mock the admin tokens endpoint with a moderately wide payload —
    // a token with multiple permissions, a long name, and timestamps.
    // This is the realistic worst case Marc hit on prod.
    await page.route("**/api/admin/tokens", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "tok1",
              name: "iOS app device-AABBCCDDEEFF",
              permissions: ["measurements:write", "medications:read", "*"],
              lastUsedAt: "2026-05-08T12:00:00Z",
              expiresAt: null,
              createdAt: "2026-05-01T08:00:00Z",
              revoked: false,
              user: { id: "u1", username: "marc-the-very-long-username" },
            },
            {
              id: "tok2",
              name: "Native client xyz",
              permissions: ["*"],
              lastUsedAt: null,
              expiresAt: "2026-08-01T00:00:00Z",
              createdAt: "2026-04-15T08:00:00Z",
              revoked: false,
              user: { id: "u1", username: "marc-the-very-long-username" },
            },
          ],
          error: null,
        }),
      }),
    );

    await page.goto("/admin/api-tokens", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // The mobile card-list must be visible and the desktop table must
    // be display:none at this viewport.
    await expect(page.getByTestId("admin-tokens-mobile-list")).toBeVisible({
      timeout: 10_000,
    });

    const dims = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(
      dims.scrollWidth,
      `scrollWidth=${dims.scrollWidth}, innerWidth=${dims.innerWidth}`,
    ).toBeLessThanOrEqual(dims.innerWidth + 1);
  });

  // v1.4.18 phase A2 — production probe at Pixel-5 viewport pinned the
  // visible "scrollbar" Marc reported for the third time as the
  // `<AdminShell>` mobile section strip, NOT the api-tokens table. The
  // strip carries 13 admin sections so its scrollWidth (~1700 CSS px)
  // permanently exceeds clientWidth (~360 CSS px). Adding the
  // `no-scrollbar` utility class (`globals.css`) suppresses the
  // painted bar while preserving swipe + keyboard-arrow scrolling.
  // This regression guard fails if a future refactor drops the class.
  test("Pixel-5 viewport: admin section strip suppresses its painted scrollbar", async ({
    page,
  }) => {
    await page.route("**/api/admin/tokens", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [], error: null }),
      }),
    );

    await page.goto("/admin/api-tokens", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Find the mobile strip (`<nav aria-label>` matches both English
    // "Admin sections" and German "Admin-Bereiche").
    const strip = page.locator("nav.no-scrollbar.overflow-x-auto").first();
    await expect(strip).toBeAttached();

    // The strip itself must declare `no-scrollbar` so the painted
    // horizontal scrollbar — which production showed at Pixel-5 — is
    // suppressed.
    const cls = await strip.getAttribute("class");
    expect(cls ?? "").toContain("no-scrollbar");
    expect(cls ?? "").toContain("overflow-x-auto");

    // And the strip must still carry useful overflow internally
    // (clientWidth < scrollWidth), proving scroll behaviour isn't
    // disabled — only the bar is invisible.
    const stripDims = await strip.evaluate((el) => ({
      scrollWidth: (el as HTMLElement).scrollWidth,
      clientWidth: (el as HTMLElement).clientWidth,
    }));
    expect(stripDims.scrollWidth).toBeGreaterThan(stripDims.clientWidth);
  });
});
