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
 * Medication wizard end-to-end — weekdays cadence.
 *
 * Walks the seven-step wizard via the DE label surface and picks
 * "An bestimmten Wochentagen" on step 3, toggles Mo + Mi + Fr on the
 * weekday chip-row, then completes the rest of the flow. The emitted
 * rrule is `FREQ=WEEKLY;BYDAY=MO,WE,FR`.
 */
test.describe("medication wizard — weekdays", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a Mon/Wed/Fri medication end-to-end", async ({ page }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Ibuprofen",
      dose: "400 mg",
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      rollingIntervalDays: null,
      oneShot: false,
    });

    await page.goto("/medications/new", { waitUntil: "domcontentloaded" });

    await fillStep1(page, { name: "Ibuprofen", doseAmount: "400" });
    await clickNext(page);

    await expectStep(page, 2);
    await page.getByRole("radio", { name: /Wiederkehrend/i }).click();
    await clickNext(page);

    await expectStep(page, 3);
    await page
      .getByRole("radio", { name: /An bestimmten Wochentagen/i })
      .click();

    // Toggle Mo + Mi + Fr — `aria-label` uses the long DE name.
    await page
      .getByRole("button", { name: /^Montag$/i })
      .click();
    // The "weekdays" default is [MO] so Monday may already be active;
    // re-toggle if so. Cheaper than peeking at aria-pressed: just lean
    // on the data-active attribute.
    const moChip = page.locator(
      '[data-slot="cadence-weekday-chip"][data-token="MO"]',
    );
    if ((await moChip.getAttribute("data-active")) === "false") {
      await moChip.click();
    }
    await page.getByRole("button", { name: /^Mittwoch$/i }).click();
    await page.getByRole("button", { name: /^Freitag$/i }).click();
    await clickNext(page);

    await expectStep(page, 4);
    await clickNext(page);

    await expectStep(page, 5);
    await clickNext(page);

    await expectStep(page, 6);
    await clickNext(page);

    await expectStep(page, 7);
    const summary = page.locator('[data-slot="wizard-step7-summary"]');
    await expect(summary).toContainText(/An ausgewählten Wochentagen/i);

    await clickCreate(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Ibuprofen",
      oneShot: false,
      schedules: [{ rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }],
    });

    await expectMedicationOnList(page, {
      name: "Ibuprofen",
      withNextDueChip: true,
    });
  });
});
