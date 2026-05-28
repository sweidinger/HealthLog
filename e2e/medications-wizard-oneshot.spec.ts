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
 * Medication wizard end-to-end — one-shot cadence.
 *
 * Picking "Einmaldosis" on step 2 short-circuits the wizard past
 * steps 3 + 4 and lands on step 5, where the user picks the single
 * dose date alongside the time-of-day chip. Step 6 keeps endsOn
 * pinned to startsOn via `lockEndsToStart`, and step 7 surfaces the
 * "Einmaldosis" summary phrase.
 *
 * The list-page next-due chip is suppressed for one-shot medications
 * because the design-synthesis lifecycle deactivates the row the
 * moment the single intake is logged. The spec only asserts the row
 * name appears on the list.
 */
test.describe("medication wizard — one-shot", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creates a single-dose medication end-to-end", async ({ page }) => {
    await stubDashboardAnalytics(page);
    const capture = mockMedicationsApi(page, {
      id: STUB_MEDICATION_ID,
      name: "Grippeimpfung",
      dose: "0.5 ml",
      rrule: null,
      rollingIntervalDays: null,
      oneShot: true,
    });

    await page.goto("/medications/new", { waitUntil: "domcontentloaded" });

    await fillStep1(page, { name: "Grippeimpfung", doseAmount: "0.5" });
    await page.locator("#wizard-dose-unit").click();
    await page.getByRole("option", { name: /^ml$/i }).click();
    await clickNext(page);

    await expectStep(page, 2);
    await page.getByRole("radio", { name: /Einmaldosis/i }).click();

    // The wizard skips steps 3 + 4 in one-shot mode — clicking Next on
    // step 2 jumps directly to step 5 (see `goNext` in CreationWizard).
    await clickNext(page);

    await expectStep(page, 5);
    // One-shot variant renders the single time picker (maxChips=1) and
    // a dose-date input. The default startsOn is today; we override to
    // a fixed date so the assertion below is deterministic.
    const oneShotDate = page.locator("#wizard-oneshot-date");
    await expect(oneShotDate).toBeVisible();
    await oneShotDate.fill("2026-10-15");
    await clickNext(page);

    await expectStep(page, 6);
    // One-shot pins endsOn to startsOn — the end-date input is
    // read-only and the "Kein Enddatum" Switch is hidden.
    await expect(
      page.locator('[data-slot="course-window-ends"]'),
    ).toHaveValue("2026-10-15");
    await expect(
      page.locator('[data-slot="course-window-oneshot-caption"]'),
    ).toBeVisible();
    await clickNext(page);

    await expectStep(page, 7);
    const summary = page.locator('[data-slot="wizard-step7-summary"]');
    await expect(summary).toContainText(/Einmaldosis/i);
    await expect(summary).toContainText(/2026-10-15/);

    await clickCreate(page);

    await expectRedirectToMedication(page, STUB_MEDICATION_ID);
    expect(capture.postBody).toMatchObject({
      name: "Grippeimpfung",
      oneShot: true,
      startsOn: "2026-10-15",
      endsOn: "2026-10-15",
    });

    await expectMedicationOnList(page, {
      name: "Grippeimpfung",
      withNextDueChip: false,
    });
  });
});
