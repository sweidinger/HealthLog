import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Add-measurement flow — exercises the dashboard's quick-entry dropdown,
 * the dialog-mounted MeasurementForm, the POST to /api/measurements, and
 * the resulting query invalidation that surfaces the row on
 * `/measurements`.
 *
 * Weight is the simplest type (single numeric input + datetime), so it
 * keeps the spec focused on the round-trip rather than the BP three-field
 * batched submit.
 */
test.describe("add measurement flow", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("creating a weight reading surfaces it in the list", async ({
    page,
  }) => {
    // Capture the POST payload so we can assert against it independently
    // of any list-fetch response Playwright might cache. Match both
    // `/api/measurements` (POST creates a reading) and the list query
    // `/api/measurements?type=...&limit=...&offset=...` (GET).
    let postedBody: unknown = null;
    await page.route("**/api/measurements*", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        postedBody = JSON.parse(req.postData() ?? "null");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { id: "m_e2e_1", success: true },
            error: null,
          }),
        });
        return;
      }
      // GET — return the just-posted reading so the list view shows it.
      // The list expects `data.measurements: Measurement[]` plus
      // `data.meta.total`; chart fetches use the same envelope.
      const body = postedBody as {
        type?: string;
        value?: number;
        measuredAt?: string;
      } | null;
      const measurements = body
        ? [
            {
              id: "m_e2e_1",
              type: body.type,
              value: body.value,
              measuredAt: body.measuredAt,
              notes: null,
            },
          ]
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { measurements, meta: { total: measurements.length } },
          error: null,
        }),
      });
    });

    // Dashboard's analytics fetch — empty summaries are fine; we only
    // need the page to render so we can click "Add".
    await page.route("**/api/analytics", (route) =>
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

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // Open the "Add" dropdown — the dashboard's quick-entry trigger sits
    // at the top-right of `<main>`. Scope the locator there so we don't
    // accidentally match an "Add" button on the sidebar.
    const main = page.locator("main");
    await main
      .getByRole("button", { name: /^add$|hinzufügen|hinzufuegen/i })
      .first()
      .click();

    // The Radix DropdownMenu mounts its content in a portal; the role
    // is `menuitem`. Both items currently render the literal "Add" in
    // EN (measurements.addMeasurement = "Add", mood.addEntry = "Add"),
    // so we disambiguate by hitting the FIRST one — that's the
    // measurement entry per the dashboard JSX order. Sub-optimal, but
    // robust against the i18n collision we don't want to fix in this
    // phase (would touch dashboard copy).
    await page.getByRole("menuitem").first().click();

    // Form should be visible inside the dialog. Switch type to WEIGHT
    // (combo-box defaults to BLOOD_PRESSURE).
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The Select trigger renders the current label — click to open and
    // pick the weight option.
    await dialog.getByRole("combobox").first().click();
    await page
      .getByRole("option", { name: /weight|gewicht/i })
      .first()
      .click();

    // Weight is single-value mode — fill the value field with 78.4 kg.
    const valueInput = dialog.locator("#value");
    await valueInput.fill("78.4");

    // Save
    await dialog.getByRole("button", { name: /save|speichern/i }).click();

    // Dialog closes when the mutation succeeds
    await expect(dialog).toBeHidden({ timeout: 5_000 });

    // Assert the POST went through with the expected shape
    expect(postedBody).toMatchObject({
      type: "WEIGHT",
      value: 78.4,
    });

    // Navigate to the list and confirm the entry surfaces. The list
    // page renders entries from /api/measurements which we've mocked
    // to echo the just-posted row.
    await page.goto("/measurements", { waitUntil: "domcontentloaded" });

    // The list renders a desktop table AND a mobile card grid (one is
    // hidden via `md:hidden`/`hidden md:block`). At least one match
    // means our row landed in the DOM regardless of viewport.
    await expect
      .poll(
        async () =>
          await page
            .locator("main")
            .getByText(/78[.,]4/)
            .count(),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);
  });
});
