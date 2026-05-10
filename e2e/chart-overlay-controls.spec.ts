import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.18 — per-chart overlay-controls popover.
 *
 * Marc reverted v1.4.16's always-on chart overlays (gradient fill,
 * personal-baseline line, target-zone shading) and asked for per-chart
 * switches that the user can flip on or off. This spec exercises the
 * end-to-end behaviour against the seeded test user:
 *
 *   1. Dashboard renders with a chart.
 *   2. The chart card has a settings cog in its header.
 *   3. Clicking the cog opens a popover with three switches.
 *   4. Toggling "Target range" on triggers a PUT /api/dashboard/chart-overlay-prefs.
 */
test.describe("chart overlay controls", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Mock analytics + measurements so the dashboard paints at least
    // one chart card. Same seed shape the dashboard.spec.ts uses.
    await page.route("**/api/analytics", (route) =>
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
            },
            bpInTargetPct: 0,
            glucoseByContext: {},
          },
          error: null,
        }),
      }),
    );
    await page.route("**/api/mood/analytics", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { entries: [], summary: { count: 0 } },
          error: null,
        }),
      }),
    );
    await page.route("**/api/measurements*", (route) => {
      const measurements = Array.from({ length: 10 }, (_, i) => ({
        id: `m_${i}`,
        type: "WEIGHT",
        value: 78 + (i % 3) - 1,
        measuredAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        notes: null,
      }));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements, meta: { total: measurements.length } },
          error: null,
        }),
      });
    });
  });

  test("opens the overlay-controls popover and saves a toggle change", async ({
    page,
  }) => {
    let putRequestCount = 0;
    await page.route("**/api/dashboard/chart-overlay-prefs", async (route) => {
      if (route.request().method() === "PUT") {
        putRequestCount += 1;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { saved: true }, error: null }),
      });
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the dashboard tile-strip to settle so we know the user
    // is past initial auth + layout-fetch.
    await expect(
      page.locator('[data-slot="dashboard-tile-strip"]'),
    ).toBeVisible({ timeout: 10_000 });

    // The weight chart is one of the always-visible default charts and
    // it ships an overlay-controls trigger because the dashboard plumbs
    // a chartKey into it.
    const trigger = page
      .locator('[data-slot="chart-overlay-controls-trigger"]')
      .first();
    await expect(trigger).toBeVisible({ timeout: 10_000 });

    await trigger.click();

    // The popover content paints three switches.
    await expect(
      page.locator('[data-slot="chart-overlay-toggle-target-range"]'),
    ).toBeVisible({ timeout: 5_000 });

    // Toggle target-range on. Radix Switch is a button[role=switch].
    await page
      .locator('[data-slot="chart-overlay-toggle-target-range"]')
      .click();

    // The PUT fires once for the toggle change.
    await expect.poll(() => putRequestCount).toBeGreaterThan(0);
  });
});
