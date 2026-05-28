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
 * Medication wizard end-to-end — bi-weekly cadence (every N weeks).
 *
 * The "everyNWeeks" picker carries two sub-controls: an integer-week
 * input (defaults to 2) and a weekday chip row (defaults to [MO]).
 * Keeping both defaults yields `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO`,
 * which the step-7 summary phrase pins as "Alle zwei Wochen".
 *
 * Bi-weekly is the canonical regression case from the design-synthesis
 * (the pre-v1.5 reminder worker ignored intervalWeeks). This spec
 * pins the wizard's emit path; the worker fix lives in the unit suite.
 */
test.describe("medication wizard — bi-weekly", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates an every-2-weeks Monday medication end-to-end", async ({
    page,
  }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Methotrexat",
      dose: "10 mg",
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await page.goto("/medications/new", { waitUntil: "domcontentloaded" });

    await fillStep1(page, { name: "Methotrexat", doseAmount: "10" });
    await clickNext(page);

    await expectStep(page, 2);
    await page.getByRole("radio", { name: /Wiederkehrend/i }).click();
    await clickNext(page);

    await expectStep(page, 3);
    await page
      .getByRole("radio", { name: /Alle N Wochen an bestimmten Tagen/i })
      .click();

    // Sub-controls render inline. The integer input defaults to 2; we
    // re-fill it explicitly so the spec is robust to default drift.
    const weeksInput = page
      .locator('[data-slot="cadence-number-input"]')
      .first();
    await weeksInput.fill("2");

    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5);
    await clickNext(page);

    await expectStep(page, 6);
    await clickNext(page);

    await expectStep(page, 7);
    const summary = page.locator('[data-slot="wizard-step7-summary"]');
    // n=2 collapses to the "biweekly" summary leaf (intervalWeeks ===
    // 2 short-circuits in `summaryKeyForCadence`).
    await expect(summary).toContainText(/Alle zwei Wochen/i);

    await clickCreate(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Methotrexat",
      oneShot: false,
      schedules: [{ rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" }],
    });

    await expectMedicationOnList(page, {
      name: "Methotrexat",
      withNextDueChip: true,
    });
  });
});
