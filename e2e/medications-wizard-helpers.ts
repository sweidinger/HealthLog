import { expect, type Page, type Route } from "@playwright/test";

/**
 * Shared helpers for the medication-wizard cadence specs.
 *
 * The six specs (daily / weekdays / biweekly / monthly / rolling /
 * oneshot) walk the same seven-step skeleton with different sub-step
 * inputs. The shared pieces — POST + GET stubs, list-page entry check,
 * step-indicator assertions, dashboard analytics stub — live here so
 * the per-cadence specs only carry the cadence-specific selectors.
 *
 * No abstraction over the seven steps themselves: the cadence-specific
 * differences (which radio to pick, which sub-control to fill) are the
 * point of the spec, so the per-spec code expresses them directly.
 */

/** The medication id the POST stub echoes back to the wizard. */
export const STUB_MEDICATION_ID = "med_e2e_wizard";

/**
 * The minimum medication shape `/medications` page reads through
 * `MedicationCard`. The list reads `data: Medication[]` and the card
 * itself is forgiving about missing optional fields.
 */
interface StubbedMedication {
  id: string;
  name: string;
  dose: string;
  rrule: string | null;
  rollingIntervalDays: number | null;
  oneShot: boolean;
}

/**
 * Mock `/api/medications` for both the POST (creation) and the GET
 * (list refresh after the wizard redirects). Returns the captured
 * request body so each spec can assert against it independently.
 *
 * The list GET echoes the just-posted medication so the `/medications`
 * page paints a card the spec can pin against.
 */
export function mockMedicationsApi(page: Page, stubbed: StubbedMedication) {
  const capture: { postBody: unknown } = { postBody: null };

  // The list page reads the schedule shape too — surface the new
  // v1.5 fields the card consumes (rrule, rollingIntervalDays, oneShot,
  // timesOfDay). windowStart/windowEnd stay required by the card's
  // legacy fallback even when timesOfDay is populated.
  const listEntry = {
    id: stubbed.id,
    name: stubbed.name,
    dose: stubbed.dose,
    category: "MEDICATION",
    active: true,
    notificationsEnabled: true,
    pausedAt: null,
    lastTakenAt: null,
    startsOn: null,
    endsOn: null,
    oneShot: stubbed.oneShot,
    schedules: [
      {
        id: "sch_e2e_1",
        windowStart: "08:00",
        windowEnd: "09:00",
        label: null,
        dose: null,
        daysOfWeek: null,
        timesOfDay: ["08:00"],
        rrule: stubbed.rrule,
        rollingIntervalDays: stubbed.rollingIntervalDays,
        reminderGraceMinutes: null,
      },
    ],
  };

  // The `**/api/medications*` glob matches the bare collection URL the
  // wizard posts to AND the list query the medications page issues.
  // Routes registered earlier win, so the list page never falls through
  // to a real server response.
  void page.route("**/api/medications**", async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Sub-paths (e.g. /api/medications/<id>/...) — let them through
    // unhandled so the spec only stubs the surfaces it owns.
    if (url.pathname !== "/api/medications") {
      await route.fallback();
      return;
    }
    if (req.method() === "POST") {
      capture.postBody = JSON.parse(req.postData() ?? "null");
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          data: { ...listEntry },
          error: null,
        }),
      });
      return;
    }
    if (req.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [listEntry],
          error: null,
        }),
      });
      return;
    }
    await route.fallback();
  });

  return capture;
}

/**
 * Stub the analytics fetches that fire on `/medications` so the page
 * paints without depending on the seed user's measurement state. The
 * `/api/analytics(?slice=…)` regex matches both the slim and thick
 * dashboard variants — same pattern the other specs use.
 */
export async function stubDashboardAnalytics(page: Page): Promise<void> {
  await page.route(/\/api\/analytics(\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: { summaries: {}, bpInTargetPct: null, glucoseByContext: {} },
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
}

/**
 * Fill the Step 1 name + dose-amount inputs and confirm the step
 * indicator reads "Schritt 1 von 7" before we leave it. The dose unit
 * already defaults to "mg" via `emptyWizardPayload()` so we leave it
 * alone unless the caller wants something else.
 */
export async function fillStep1(
  page: Page,
  { name, doseAmount }: { name: string; doseAmount: string },
): Promise<void> {
  await expect(page.getByText(/Schritt 1 von 7/i)).toBeVisible();
  await page.locator("#wizard-name").fill(name);
  await page.locator("#wizard-dose-amount").fill(doseAmount);
}

/**
 * Click the wizard's primary Next button. Pinned by data-slot so we do
 * not collide with any other "Weiter" / "Next" labelled control the
 * page chrome may render.
 */
export async function clickNext(page: Page): Promise<void> {
  await page.locator('[data-slot="wizard-next"]').click();
}

/**
 * Click the wizard's primary Create button at step 7.
 */
export async function clickCreate(page: Page): Promise<void> {
  await page.locator('[data-slot="wizard-create"]').click();
}

/** Wait for the wizard to land on a given step (1-7). */
export async function expectStep(page: Page, step: number): Promise<void> {
  await expect(
    page.getByText(new RegExp(`Schritt ${step} von 7`, "i")),
  ).toBeVisible();
}

/**
 * Verify the post-submit URL settles on `/medications/<id>`. Next.js
 * 404s for an unknown id which renders the `not-found.tsx` boundary
 * cleanly; the URL is the contract we care about, not the page body.
 */
export async function expectRedirectToMedication(
  page: Page,
  id: string,
): Promise<void> {
  await expect
    .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
    .toBe(`/medications/${id}`);
}

/**
 * Navigate to the list and assert the just-created medication appears
 * with the "Nächste Einnahme:" next-due chip (`medications.nextIntake`
 * leaf in `messages/de.json`). The one-shot variant uses a different
 * surface — the list still shows the medication name; we only assert
 * on the chip for recurring cadences.
 */
export async function expectMedicationOnList(
  page: Page,
  { name, withNextDueChip }: { name: string; withNextDueChip: boolean },
): Promise<void> {
  await page.goto("/medications", { waitUntil: "domcontentloaded" });
  const main = page.locator("main");
  await expect(main.getByText(name).first()).toBeVisible({ timeout: 10_000 });
  if (withNextDueChip) {
    // "Nächste Einnahme:" with the trailing colon is the literal label
    // surfaced by `medications.nextIntake`. The card renders the chip
    // when the medication is active AND has a next schedule slot, both
    // true for the stubbed entry.
    await expect(main.getByText(/Nächste Einnahme:/i).first()).toBeVisible();
  }
}
