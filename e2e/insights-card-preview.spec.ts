import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 phase D reconcile (CRITICAL C2) — proves the polished
 * `<InsightsCardPreview>` is mounted on the root dashboard `/`.
 *
 * Before this fix the component shipped in B1b commit 5 (`d2cdf9d`)
 * was an orphan with zero non-test imports. The dashboard read no
 * advisor payload, so the top severity-ordered AI recommendation +
 * confidence ring + "View all" CTA was unreachable from any live
 * route. This spec asserts the card now renders when the layout
 * toggle is active and the advisor returns at least one rec.
 */
test.describe("insights card preview on dashboard (C2)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Populated analytics so the dashboard clears its empty-state and
    // renders charts + tile strip.
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
            bpInTargetPct: null,
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

    // Layout enables the insights preview widget so the gate is open.
    await page.route("**/api/dashboard/widgets", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            version: 1,
            widgets: [
              { id: "weight", visible: true, tileVisible: true, order: 0 },
              {
                id: "insightsPreview",
                visible: true,
                tileVisible: false,
                order: 14,
              },
            ],
            comparisonBaseline: "none",
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

    // Advisor payload — populated with one urgent rec carrying a
    // confidence score so the preview renders the rec text + the
    // ring confidence meter inline.
    await page.route("**/api/insights/generate", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            insights: {
              insightType: "general",
              summary: "Weekly summary.",
              classification: "gut",
              classificationLabel: "Good",
              findings: [],
              correlations: [],
              primaryRecommendation: "",
              recommendations: [
                {
                  id: "rec-urgent-1",
                  text: "Schedule a follow-up reading this week.",
                  severity: "urgent",
                  confidence: 82,
                  rationale: {
                    dataWindow: "last7days",
                    comparedTo: "your 90-day median",
                    deviation: "Sys BP averaged 138 over the past week",
                  },
                  metricSource: {
                    type: "bloodPressureSys",
                    timeRange: "last7days",
                    summary: "Sys BP avg 138",
                  },
                },
              ],
              dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
              disclaimer: "Not medical advice.",
            },
            cached: true,
            cachedAt: new Date().toISOString(),
            legacyPayload: false,
          },
          error: null,
        }),
      }),
    );
  });

  test("dashboard renders InsightsCardPreview with top recommendation", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Preview is the C2 deliverable — `data-slot="insights-card-preview"`
    // is the stable hook the component exposes.
    await expect(
      page.locator('[data-slot="insights-card-preview"]'),
    ).toBeVisible({ timeout: 10_000 });

    // The urgent rec text from the mock payload renders inside the
    // preview's compact tile.
    await expect(
      page.getByText("Schedule a follow-up reading this week."),
    ).toBeVisible({ timeout: 10_000 });

    // "View all" CTA points at /insights so the user can drill in.
    await expect(
      page.locator('[data-slot="insights-card-view-all"]'),
    ).toBeVisible({ timeout: 10_000 });

    // The ring-variant ConfidenceMeter renders inline next to the rec
    // text — its slot is the same one used on /insights, so a single
    // selector confirms wiring.
    await expect(
      page.locator(
        '[data-slot="insights-card-preview"] [data-slot="confidence-meter"]',
      ),
    ).toBeVisible({ timeout: 10_000 });
  });
});
