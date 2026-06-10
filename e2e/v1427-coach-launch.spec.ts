import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Coach launch surfaces on `/insights/{slug}` sub-pages.
 *
 * Contracts under test (v1.16.1):
 *
 *   1. The floating bubble (`data-slot="coach-nudge-bubble"`) renders
 *      ONLY while an unread Coach-initiated nudge exists
 *      (`GET /api/insights/coach/nudge-status`). By default no bubble
 *      mounts on any viewport; the everyday entry point is the inline
 *      launch the sub-page shell mounts in the header
 *      (`data-slot="coach-launch-icon"`, visible across breakpoints).
 *
 *   2. Clicking the inline launch opens the Coach drawer — as a
 *      bottom-sheet (`data-variant="bottom-sheet"`) on `<sm`, as a
 *      right-side sheet (`data-variant="side-sheet"`) on `>=sm`.
 *
 *   3. With an unread nudge the bubble mounts and clicking it
 *      navigates to the full-page chat at `/insights/coach`.
 *
 *   4. The drawer's "Conversations" button no longer opens an in-panel
 *      tray; it hands off to the full-page route `/insights/coach`.
 *
 * The three sub-pages covered (blutdruck, gewicht, schlaf) span the
 * empty-state branch (no data → CTA + Coach launch) and the populated
 * branch (with data → full chart + Coach launch in the header).
 */
test.describe("Coach launch surfaces on insights sub-pages", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Populated analytics so each sub-page paints the data branch
    // (`hasMetricData` true) — the inline Coach launch is mounted in
    // the sub-page header by the shell.
    // Regex form matches the slim slice the dashboard split fires
    // alongside the thick request.
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

    // Default nudge state: nothing unread. Registered AFTER the
    // generic `**-status*` mock so it wins for the nudge endpoint
    // (Playwright matches routes in reverse registration order).
    await page.route("**/api/insights/coach/nudge-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { nudgedAt: null, unread: false },
          error: null,
        }),
      }),
    );
  });

  for (const slug of ["blutdruck", "gewicht", "schlaf"] as const) {
    test(`/insights/${slug} mounts the inline Coach launch and no bubble by default on Pixel 5`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-mobile",
        "mobile inline-launch branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      // The header launch icon is the everyday entry point — visible
      // on mobile too since the layout bubble is nudge-gated.
      const icon = page.locator('[data-slot="coach-launch-icon"]').first();
      await expect(icon).toBeVisible({ timeout: 10_000 });

      // No unread nudge → no floating bubble in the DOM.
      await expect(
        page.locator('[data-slot="coach-nudge-bubble"]'),
      ).toHaveCount(0);
    });

    test(`/insights/${slug} mounts the inline Coach launch and no bubble by default on Desktop Chrome`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-desktop",
        "desktop inline-launch branch",
      );

      await page.goto(`/insights/${slug}`, { waitUntil: "domcontentloaded" });

      const icon = page.locator('[data-slot="coach-launch-icon"]').first();
      await expect(icon).toBeVisible({ timeout: 10_000 });

      await expect(
        page.locator('[data-slot="coach-nudge-bubble"]'),
      ).toHaveCount(0);
    });
  }

  test("clicking the inline Coach launch opens the drawer as a bottom-sheet on Pixel 5", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-mobile",
      "drawer bottom-sheet branch is mobile-only",
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const icon = page.locator('[data-slot="coach-launch-icon"]').first();
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();

    const drawer = page.locator('[data-slot="coach-drawer"]');
    await expect(drawer).toBeVisible({ timeout: 10_000 });
    await expect(drawer).toHaveAttribute("data-variant", "bottom-sheet");
  });

  test("clicking the inline Coach launch opens the drawer as a side-sheet on Desktop Chrome", async ({
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

  test("an unread Coach nudge mounts the floating bubble and clicking it opens the full-page chat", async ({
    page,
  }) => {
    // The bubble contract is viewport-independent — the test runs on
    // both projects. Override the default nudge mock with an unread
    // one (later registration wins).
    await page.route("**/api/insights/coach/nudge-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { nudgedAt: "2026-06-09T06:00:00.000Z", unread: true },
          error: null,
        }),
      }),
    );

    await page.goto("/insights/blutdruck", { waitUntil: "domcontentloaded" });

    const bubble = page.locator('[data-slot="coach-nudge-bubble"]');
    await expect(bubble).toBeVisible({ timeout: 10_000 });
    await bubble.click();

    await page.waitForURL("**/insights/coach", { timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-page"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("the drawer's Conversations button hands off to the full-page chat on Desktop Chrome", async ({
    page,
  }, testInfo) => {
    // The in-panel history tray is gone from the drawer; the button
    // navigates to `/insights/coach` where the conversation list
    // renders inline on lg+.
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

    // The drawer renders no inline history column.
    await expect(
      page.locator('[data-slot="coach-drawer-history"]'),
    ).toHaveCount(0);

    const historyButton = page.locator(
      '[data-slot="coach-drawer-history-tray-trigger"]',
    );
    await expect(historyButton).toBeVisible({ timeout: 10_000 });
    await historyButton.click();

    // No in-panel tray opens — the click navigates to the full view.
    await page.waitForURL("**/insights/coach", { timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-page"]'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-slot="coach-drawer-history-tray"]'),
    ).toHaveCount(0);
  });
});
