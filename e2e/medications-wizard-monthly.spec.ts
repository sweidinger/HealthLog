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
 * Medication wizard end-to-end — monthly cadence.
 *
 * Picks "Monatlich an einem bestimmten Tag" on step 3 and pins
 * dayOfMonth = 15. The emitted rrule is `FREQ=MONTHLY;BYMONTHDAY=15`
 * and the step-7 summary surfaces the "Monatlich" phrase.
 */
test.describe("medication wizard — monthly", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a monthly-on-day-15 medication end-to-end", async ({
    page,
  }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Vitamin B12",
      dose: "1000 mcg",
      rrule: "FREQ=MONTHLY;BYMONTHDAY=15",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await page.goto("/medications/new", { waitUntil: "domcontentloaded" });

    await fillStep1(page, { name: "Vitamin B12", doseAmount: "1000" });
    await clickNext(page);

    await expectStep(page, 2);
    await page.getByRole("radio", { name: /Wiederkehrend/i }).click();
    await clickNext(page);

    await expectStep(page, 3);
    await page
      .getByRole("radio", { name: /Monatlich an einem bestimmten Tag/i })
      .click();

    // Set day-of-month to 15. The sub-control input is the only number
    // input inside the selected `monthly` option block.
    const dayInput = page
      .locator('[data-slot="cadence-number-input"]')
      .first();
    await dayInput.fill("15");

    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5);
    await clickNext(page);

    await expectStep(page, 6);
    await clickNext(page);

    await expectStep(page, 7);
    const summary = page.locator('[data-slot="wizard-step7-summary"]');
    await expect(summary).toContainText(/Monatlich/i);

    await clickCreate(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Vitamin B12",
      oneShot: false,
      schedules: [{ rrule: "FREQ=MONTHLY;BYMONTHDAY=15" }],
    });

    await expectMedicationOnList(page, {
      name: "Vitamin B12",
      withNextDueChip: true,
    });
  });
});
