import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.15 phase-B4 — /achievements navigation smoke.
 *
 * The page itself has unit-test coverage for the locked-vs-unlocked
 * card render; this spec answers the higher-level "can the user reach
 * the page from the global nav?" question. We mock
 * `/api/gamification/achievements` so the assertion does not depend on
 * the seed user actually having any achievement data — the routing +
 * sidebar wiring is what matters here, not the data freshness.
 */
test.describe("achievements page is reachable from the sidebar", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/gamification/achievements", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summary: {
              unlockedCount: 0,
              totalCount: 38,
              earnedPoints: 0,
              totalPoints: 9999,
              completionPercent: 0,
              nextAchievement: null,
            },
            achievements: [
              {
                id: "intake-total-1",
                metric: "totalTakenIntakes",
                category: "medication",
                titleKey: "achievements.badges.intakeTotal1.title",
                descriptionKey: "achievements.badges.intakeTotal1.description",
                icon: "Pill",
                format: "count",
                target: 1,
                current: 0,
                points: 8,
                unlocked: false,
                progressPercent: 0,
                completedAt: null,
              },
            ],
            metrics: {},
          },
          error: null,
        }),
      }),
    );
  });

  test("desktop sidebar exposes the achievements link", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // The sidebar nav is hidden on small viewports (`md:flex`); the
    // chromium-desktop project uses 1280×720 so it's visible here. Match
    // by aria-label so we don't accidentally pick up a tooltip.
    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole("link", { name: "Achievements" }).click();
    await expect(page).toHaveURL(/\/achievements\b/);
    // Page title from the loaded route. The unit test guards the
    // grouped + locked-card render shape; here we only assert the route
    // mounted and rendered the heading.
    await expect(
      page.getByRole("heading", { name: "Achievements" }),
    ).toBeVisible({ timeout: 5000 });
  });
});
