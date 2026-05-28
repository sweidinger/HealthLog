import { expect, test } from "@playwright/test";

import {
  STUB_MEDICATION_ID,
  clickCreate,
  clickNext,
  expectMedicationOnList,
  expectRedirectToMedication,
  expectStep,
  fillStep1,
  mockMedicationsApi,
  stubDashboardAnalytics,
} from "./medications-wizard-helpers";
import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Medication wizard end-to-end — rolling cadence.
 *
 * The flexible-rolling cadence is the design-synthesis differentiator
 * (only Dosecast + MedTimer model it among commercial competitors).
 * The wizard emits a `rollingIntervalDays` integer in place of an
 * rrule string; the step-7 summary surfaces the "Alle {n} Tage seit
 * der letzten Einnahme" phrase.
 *
 * The spec pins rollingDays = 7 — the canonical Mounjaro / Ozempic
 * cadence the design-synthesis P-2 case is anchored on.
 */
test.describe("medication wizard — rolling", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates an every-7-days-from-last-intake medication end-to-end", async ({
    page,
  }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Mounjaro",
      dose: "5 mg",
      rrule: null,
      rollingIntervalDays: 7,
      oneShot: false,
    });

    await page.goto("/medications/new", { waitUntil: "domcontentloaded" });

    await fillStep1(page, { name: "Mounjaro", doseAmount: "5" });
    await clickNext(page);

    await expectStep(page, 2);
    await page.getByRole("radio", { name: /Wiederkehrend/i }).click();
    await clickNext(page);

    await expectStep(page, 3);
    await page
      .getByRole("radio", {
        name: /Alle N Tage seit der letzten Einnahme \(flexibel\)/i,
      })
      .click();

    // Set rolling-days to 7. The sub-control is the only number input
    // inside the selected `rolling` option block.
    const daysInput = page
      .locator('[data-slot="cadence-number-input"]')
      .first();
    await daysInput.fill("7");

    // The explainer is the rolling-cadence-specific guidance the
    // design-synthesis mandates — pin its presence so a future copy
    // edit that drops it surfaces here.
    await expect(
      page.locator('[data-slot="cadence-rolling-explainer"]'),
    ).toBeVisible();

    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5);
    await clickNext(page);

    await expectStep(page, 6);
    await clickNext(page);

    await expectStep(page, 7);
    const summary = page.locator('[data-slot="wizard-step7-summary"]');
    await expect(summary).toContainText(
      /Alle 7 Tage seit der letzten Einnahme/i,
    );

    await clickCreate(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Mounjaro",
      oneShot: false,
      schedules: [{ rollingIntervalDays: 7 }],
    });

    await expectMedicationOnList(page, {
      name: "Mounjaro",
      withNextDueChip: true,
    });
  });
});
