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
 * Medication wizard end-to-end — daily cadence.
 *
 * Walks the seven-step `CreationWizard` from `/medications/new` using
 * the DE label surface from `messages/de.json`, picks "Jeden Tag" on
 * step 3, accepts the default 08:00 chip on step 5, accepts today as
 * startsOn on step 6, then submits. After the POST the spec asserts
 * the URL settled on `/medications/<id>` AND the medication appears on
 * `/medications` with the "Nächste Einnahme:" chip.
 */
test.describe("medication wizard — daily", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a daily medication end-to-end", async ({ page }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Vitamin D",
      dose: "1000 iu",
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await page.goto("/medications/new", { waitUntil: "domcontentloaded" });

    // Step 1 — name + dose.
    await fillStep1(page, { name: "Vitamin D", doseAmount: "1000" });
    await page.locator("#wizard-dose-unit").click();
    await page.getByRole("option", { name: /I\.E\./i }).click();
    await clickNext(page);

    // Step 2 — Recurring.
    await expectStep(page, 2);
    await page.getByRole("radio", { name: /Wiederkehrend/i }).click();
    await clickNext(page);

    // Step 3 — cadence: "Jeden Tag" (daily is the default but we click
    // it explicitly so the spec is robust to defaults drifting).
    await expectStep(page, 3);
    await page.getByRole("radio", { name: /^Jeden Tag$/i }).click();
    await clickNext(page);

    // Step 4 — recap.
    await expectStep(page, 4);
    await expect(
      page.locator('[data-slot="wizard-step4-recap"]'),
    ).toContainText(/Jeden Tag/i);
    await clickNext(page);

    // Step 5 — times of day (08:00 default chip).
    await expectStep(page, 5);
    await expect(
      page.locator('[data-slot="times-of-day-chip"][data-time="08:00"]'),
    ).toBeVisible();
    await clickNext(page);

    // Step 6 — course window (defaults to today, no end date).
    await expectStep(page, 6);
    await expect(
      page.locator('[data-slot="course-window-starts"]'),
    ).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await clickNext(page);

    // Step 7 — summary + create.
    await expectStep(page, 7);
    const summary = page.locator('[data-slot="wizard-step7-summary"]');
    await expect(summary).toContainText(/Jeden Tag/i);
    await expect(summary).toContainText(/08:00/);

    await clickCreate(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Vitamin D",
      oneShot: false,
      schedules: [{ rrule: "FREQ=DAILY" }],
    });

    await expectMedicationOnList(page, {
      name: "Vitamin D",
      withNextDueChip: true,
    });
  });
});
