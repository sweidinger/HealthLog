import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.27 R3d MB4 — Coach reachability on `/insights/{slug}` sub-pages
 * plus the Coach drawer bottom-sheet branch on `<sm`.
 *
 * Two contracts under test:
 *
 *   1. Every routed Insights sub-page mounts a Coach launch surface.
 *      The layout renders a sticky-bottom FAB
 *      (`data-slot="coach-launch-fab"`, visible on `<lg`); v1.8.6 moved
 *      the per-page action into the sub-page header as an icon-only
 *      button (`data-slot="coach-launch-icon"`, mounted by the shell at
 *      heading height across breakpoints). The spec asserts the FAB
 *      renders on Pixel-5 and the header icon renders on Desktop Chrome.
 *
 *   2. Opening the Coach drawer on `<sm` mounts it as a bottom-sheet
 *      (`data-variant="bottom-sheet"`). On `>=sm` it mounts as a
 *      right-side sheet (`data-variant="side-sheet"`).
 *
 * The three sub-pages covered (blutdruck, gewicht, schlaf) span the
 * empty-state branch (no data → CTA + Coach launch) and the populated
 * branch (with data → full chart + Coach launch beneath).
 */
test.describe("v1.4.27 — Coach reachability on insights sub-pages", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Populated analytics so each sub-page paints the data branch
    // (`hasMetricData` true) — the Coach button is mounted at the
    // bottom of the data tree.
    // v1.4.39.3 — regex form matches the slim slice the v1.4.39.2
    // dashboard split fires alongside the thick request.
    await page.route(/\/api\/analytics(\?|$)/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {
              WEIGHT: {
                latest: 78.5,
                avg7: 78.2,
                avg30: 77.9,
                slope30: { slope: -0.05, direction: "down" },
                count: 30,
              },
              BLOOD_PRESSURE_SYS: {
                latest: 124,
                avg7: 122,
                avg30: 121,
                slope30: { slope: 0.1, direction: "flat" },
                count: 30,
              },
              BLOOD_PRESSURE_DIA: {
                latest: 80,
                avg7: 79,
                avg30: 78,
                slope30: { slope: 0.05, direction: "flat" },
                count: 30,
              },
              SLEEP_DURATION: {
                latest: 7.5,
                avg7: 7.2,
                avg30: 7.1,
                slope30: { slope: 0.0, direction: "flat" },
                count: 30,
              },
            },
            bpInTargetPct: 78,
            glucoseByContext: {},
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/measurements*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements: [], meta: { total: 0 } },
          error: null,
        }),
      }),
    );

    await page.route("**/api/insights/**-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            text: null,
            hasProvider: false,
            cached: false,
            updatedAt: null,
          },
          error: null,
        }),
      }),
    );
  });

  for (const slug of ["blutdruck", "gewicht", "schlaf"] as const) {
    test(`/insights/${slug} mounts the Coach launch button on Pixel 5 (FAB branch)`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-mobile",
        "Pixel 5 FAB branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      // The FAB slot must be present and CSS-visible at Pixel 5.
      const fab = page
        .locator('[data-slot="coach-launch-fab"]')
        .first();
      await expect(fab).toBeVisible({ timeout: 10_000 });
    });

    test(`/insights/${slug} mounts the header Coach icon on Desktop Chrome`, async ({
      page,
    }, testInfo) => {
      // Desktop Chrome viewport is 1280 — `lg` (1024) is matched so the
      // layout FAB is hidden by `lg:hidden`; the header icon the shell
      // mounts is the Coach entry on the page itself.
      test.skip(
        testInfo.project.name !== "chromium-desktop",
        "desktop header-icon branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      const icon = page.locator('[data-slot="coach-launch-icon"]').first();
      await expect(icon).toBeVisible({ timeout: 10_000 });

      const fab = page.locator('[data-slot="coach-launch-fab"]').first();
      await expect(fab).toBeHidden();
    });
  }

  test("clicking the FAB opens the Coach drawer as a bottom-sheet on Pixel 5", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "drawer bottom-sheet branch is mobile-only",
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const fab = page.locator('[data-slot="coach-launch-fab"]').first();
    await expect(fab).toBeVisible({ timeout: 10_000 });
    await fab.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "bottom-sheet");
  });

  test("clicking the header Coach icon opens the Coach drawer as a side-sheet on Desktop Chrome", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "drawer side-sheet branch is desktop-only",
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const icon = page.locator('[data-slot="coach-launch-icon"]').first();
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "side-sheet");
  });

  test("conversation history is collapsed behind a toggle that opens the tray on Desktop Chrome", async ({
    page,
  }, testInfo) => {
    // v1.12.0 — the history rail is no longer an always-on left column;
    // it lives behind the "Conversations" toggle on every viewport and
    // opens as a tray on demand so the thread keeps the full width.
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "exercises the desktop drawer layout",
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const icon = page.locator('[data-slot="coach-launch-icon"]').first();
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });

    // No inline history column — only the toggle.
    await expect(
      page.locator('[data-slot="coach-drawer-history"]'),
    ).toHaveCount(0);
    const historyToggle = page.locator(
      '[data-slot="coach-drawer-history-tray-trigger"]',
    );
    await expect(historyToggle).toBeVisible({ timeout: 10_000 });

    // The history rail surfaces only after the toggle is pressed.
    await expect(
      page.locator('[data-slot="coach-drawer-history-tray"]'),
    ).toHaveCount(0);
    await historyToggle.click();
    await expect(
      page.locator('[data-slot="coach-drawer-history-tray"]'),
    ).toBeVisible({ timeout: 10_000 });
  });
});
