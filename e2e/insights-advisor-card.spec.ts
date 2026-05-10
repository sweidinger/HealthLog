import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 phase D reconcile (CRITICAL C1) — proves the polished
 * `<InsightAdvisorCard>` is mounted on `/insights` and consumes the
 * `/api/insights/generate` payload.
 *
 * Before this fix the page rendered only `<InsightStatusCard>` (text-
 * only summary per section); the rec card surface from B5c/d/e/B1b
 * (severity-ordered grid + per-rec rationale + confidence meter +
 * thumbs feedback + medical-citation footnote) was reachable only from
 * unit tests. This spec asserts the live route now reaches it.
 */
test.describe("insights advisor card on /insights (C1)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(async ({ page }) => {
    // Stub the analytics + comprehensive endpoints with a small but
    // populated dataset so the page clears the `if (!data)` empty
    // gate and renders the body.
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
              BLOOD_PRESSURE_SYS: {
                latest: 124,
                avg7: 122,
                avg30: 121,
                slope30: { slope: 0.1, direction: "flat" },
                count: 25,
              },
              BLOOD_PRESSURE_DIA: {
                latest: 80,
                avg7: 79,
                avg30: 78,
                slope30: { slope: 0.05, direction: "flat" },
                count: 25,
              },
              PULSE: {
                latest: 68,
                avg7: 70,
                avg30: 71,
                slope30: { slope: -0.2, direction: "down" },
                count: 25,
              },
            },
            bpInTargetPct: 78,
            glucoseByContext: {},
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/insights/comprehensive", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            summaries: {},
            bmi: 24.2,
            bmiClassification: null,
            bpClassification: null,
            bpPctInTarget: 78,
            bpTargets: { sysLow: 120, sysHigh: 140, diaLow: 80, diaHigh: 90 },
            weightBpCorrelation: null,
            scatterData: [],
            bpMedicationCorrelation: null,
            bpMedicationScatterData: [],
            medications: [],
            alerts: [],
            hasOpenAiKey: true,
            dataSpanDays: 90,
            totalMeasurements: 25,
            moodSummary: null,
            moodBpCorrelation: null,
            moodBpScatterData: [],
            moodWeightCorrelation: null,
            moodWeightScatterData: [],
            moodPulseCorrelation: null,
            moodPulseScatterData: [],
          },
          error: null,
        }),
      }),
    );

    // Per-status cards still render below the advisor card; mock them
    // to a simple connected payload so the section bodies don't bail.
    for (const slug of [
      "general-status",
      "blood-pressure-status",
      "weight-status",
      "pulse-status",
      "bmi-status",
      "mood-status",
      "medication-compliance-status",
    ]) {
      await page.route(`**/api/insights/${slug}*`, (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              hasProvider: true,
              text: `Mock ${slug} text.`,
              summary: `Mock ${slug} text.`,
              cached: true,
              updatedAt: new Date().toISOString(),
              medications: [],
            },
            error: null,
          }),
        }),
      );
    }

    await page.route("**/api/dashboard/widgets", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            version: 1,
            widgets: [
              { id: "weight", visible: true, tileVisible: true, order: 0 },
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

    // The advisor query — return a populated InsightResult with one
    // urgent rec carrying rationale + confidence so the rec card has
    // something to render.
    await page.route("**/api/insights/generate", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            insights: {
              insightType: "general",
              summary: "Your blood pressure has improved slightly.",
              classification: "gut",
              classificationLabel: "Good",
              findings: [
                {
                  label: "BP avg dropped 2 mmHg",
                  value: "120/78",
                  assessment: "positive",
                },
              ],
              correlations: [],
              primaryRecommendation: "Keep up the current routine.",
              recommendations: [
                {
                  id: "rec-1",
                  text: "Consider reducing sodium intake on weekends.",
                  severity: "important",
                  confidence: 78,
                  rationale: {
                    dataWindow: "last30days",
                    comparedTo: "your 90-day median",
                    deviation: "BP averages drift up on weekends",
                  },
                  metricSource: {
                    type: "bloodPressureSys",
                    timeRange: "last30days",
                    summary: "Sys BP avg 124 vs 121 weekly median",
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

  test("renders InsightAdvisorCard with severity-ordered recommendation grid", async ({
    page,
  }) => {
    await page.goto("/insights", { waitUntil: "domcontentloaded" });

    // Hero + advisor card both render. The hero is from B1b; the
    // advisor card is the C1 deliverable.
    await expect(page.locator('[data-slot="insights-page-hero"]')).toBeVisible({
      timeout: 10_000,
    });

    // The recommendation card surface from B5c — `data-slot` markers
    // are pinned in tests, look for the rec text the mock provided.
    await expect(
      page.getByText("Consider reducing sodium intake on weekends."),
    ).toBeVisible({ timeout: 10_000 });

    // ConfidenceMeter is mounted in the rec-card slot; B5d marks the
    // component with `data-slot="confidence-meter"`.
    await expect(
      page.locator('[data-slot="confidence-meter"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // Summary surface from the advisor card carries the prose.
    await expect(
      page.getByText("Your blood pressure has improved slightly."),
    ).toBeVisible({ timeout: 10_000 });
  });
});
