import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Accessibility regression gate — fails the build if any WCAG 2.1 AA
 * violation lands in the `serious` or `critical` bucket. v1.5 phase-5
 * re-enables the `/admin` surface that phase-3 had parked while phase-4b
 * restructured the admin into per-section dynamic routes:
 *
 *   - `/auth/login`             (public)
 *   - `/`                        (dashboard, authenticated)
 *   - `/settings/integrations`   (authenticated)
 *   - `/admin`                   (admin overview — `<StatusCardGrid>`)
 *   - `/admin/system-status`     (representative admin sub-route)
 *   - `/admin/users`             (admin users management — icon-only buttons)
 *
 * The seeded user (`e2e-tester`) is provisioned with `role: ADMIN` in
 * `e2e/setup/global-setup.ts` so the same fixture covers both regular
 * and admin surfaces without a second user.
 */

function reportBlocking(
  blocking: Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"],
) {
  if (blocking.length === 0) return;
  // Pretty-print so failures are actionable in CI logs.
  console.log(
    "axe violations:\n" +
      blocking
        .map(
          (v) =>
            `  - [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes.length} node(s)\n    ${v.helpUrl}`,
        )
        .join("\n"),
  );
}

async function runAxe(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
}

test.describe("axe-core public surfaces", () => {
  for (const path of ["/auth/login"]) {
    test(`${path} has no serious or critical a11y violations`, async ({
      page,
    }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");

      const blocking = await runAxe(page);
      reportBlocking(blocking);
      expect(blocking).toHaveLength(0);
    });
  }
});

test.describe("axe-core authenticated surfaces", () => {
  // Reuse the cookie jar captured by `e2e/setup/global-setup.ts`. Login
  // ran once in global-setup so we don't burn auth rate-limit attempts.
  test.use({ storageState: STORAGE_STATE_PATH });

  // Stable mocks so the auth'd pages render deterministically — axe scans
  // need fully-painted DOM, and a flaky API would otherwise stall the
  // analyse() call until the 30s test timeout.
  test.beforeEach(async ({ page }) => {
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
  });

  for (const path of [
    "/",
    "/settings/integrations",
    "/admin",
    "/admin/system-status",
    "/admin/users",
  ]) {
    test(`${path} has no serious or critical a11y violations`, async ({
      page,
    }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      const blocking = await runAxe(page);
      reportBlocking(blocking);
      expect(blocking).toHaveLength(0);
    });
  }
});
