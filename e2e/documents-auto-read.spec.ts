/**
 * Automatic AI document reading — the per-user opt-in acceptance suite.
 *
 * Two surfaces:
 *   (1) AI settings — the single switch reveals a once-shown honesty confirm
 *       BEFORE writing the setting (off → on), and the confirm is what commits
 *       `documentsAutoAiRead: true`. Turning it off is immediate.
 *   (2) The vault detail sheet — the per-egress "leaves your machine" notice is
 *       shown once and the per-document "Read with AI" action is the explicit
 *       path; reading through it succeeds with no per-document consent prompt.
 *
 * Everything is `page.route`-mocked so the suite mutates no shared demo state.
 * The document-scoped capability endpoint is mocked on every path — an unmocked
 * / changed capability endpoint is the shipped regression that breaks the vault
 * AI e2e, so it is pinned here too. Assertions target stable data-slots, never
 * viewport-dependent text.
 */
import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  ensureVaultFixture,
  ensureVaultAiFixture,
  AI_PROBE_DOC_ID,
} from "./setup/vault-fixture";

async function fulfilJson(
  route: Parameters<Parameters<Page["route"]>[1]>[0],
  body: unknown,
) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Mock the document capability probe so the vault AI section renders. */
async function mockDocumentCapability(
  page: Page,
  opts: { egress: "local" | "external"; pdfSupported?: boolean },
): Promise<void> {
  await page.route("**/api/documents/inbound/capability", (route) =>
    fulfilJson(route, {
      data: {
        available: true,
        mode: "vision",
        reason: null,
        pdfSupported: opts.pdfSupported ?? true,
        egress: opts.egress,
      },
      error: null,
    }),
  );
}

test.describe("automatic AI reading — settings toggle", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeEach(({}, testInfo) => {
    // The confirm logic is viewport-independent; run the settings flow once on
    // desktop to keep the heavy AI-settings page off the mobile matrix.
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "settings toggle flow runs on desktop only",
    );
    test.slow();
  });

  test("turning it on reveals a once-shown honesty confirm before writing", async ({
    page,
  }) => {
    // The toggle starts OFF; capture the write so we can prove it only fires on
    // confirm (never on the raw switch flip).
    let patchBody: unknown = null;
    await page.route("**/api/auth/me/documents-auto-ai-read", (route) => {
      if (route.request().method() === "PATCH") {
        patchBody = JSON.parse(route.request().postData() ?? "{}");
        return fulfilJson(route, {
          data: { documentsAutoAiRead: true },
          error: null,
        });
      }
      return fulfilJson(route, {
        data: { documentsAutoAiRead: false },
        error: null,
      });
    });

    await page.goto("/settings/ai");
    const card = page.locator('[data-slot="documents-auto-read-card"]');
    await expect(card).toBeVisible();

    // Flip the switch ON — the honesty confirm appears and NOTHING is written.
    await card.getByTestId("documents-auto-read-enable").click();
    const confirm = card.locator('[data-slot="documents-auto-read-confirm"]');
    await expect(confirm).toBeVisible();
    expect(patchBody).toBeNull();

    // Acknowledge — now (and only now) the write fires with the true flag.
    await confirm
      .locator('[data-slot="documents-auto-read-confirm-cta"]')
      .click();
    await expect.poll(() => patchBody).toEqual({ documentsAutoAiRead: true });
    await expect(confirm).not.toBeVisible();
  });

  test("cancelling the confirm writes nothing", async ({ page }) => {
    let patchCalls = 0;
    await page.route("**/api/auth/me/documents-auto-ai-read", (route) => {
      if (route.request().method() === "PATCH") {
        patchCalls += 1;
        return fulfilJson(route, {
          data: { documentsAutoAiRead: true },
          error: null,
        });
      }
      return fulfilJson(route, {
        data: { documentsAutoAiRead: false },
        error: null,
      });
    });

    await page.goto("/settings/ai");
    const card = page.locator('[data-slot="documents-auto-read-card"]');
    await expect(card).toBeVisible();
    await card.getByTestId("documents-auto-read-enable").click();
    const confirm = card.locator('[data-slot="documents-auto-read-confirm"]');
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /cancel/i }).click();
    await expect(confirm).not.toBeVisible();
    await page.waitForTimeout(300);
    expect(patchCalls).toBe(0);
  });
});

test.describe("automatic AI reading — vault per-document contract", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeAll(async () => {
    await ensureVaultFixture();
    await ensureVaultAiFixture();
  });

  test.beforeEach(() => test.slow());

  test("the vault shows the per-egress notice once and the explicit read action", async ({
    page,
  }) => {
    // External egress (the codex/OAuth or any non-local provider case).
    await mockDocumentCapability(page, { egress: "external" });

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    // The vendor-blind "leaves your machine" notice is shown exactly once.
    await expect(
      sheet.locator('[data-slot="document-ai-egress-notice"]'),
    ).toHaveCount(1);
    // The per-document read is the explicit path — the action is present and the
    // user must tap it (auto-read never removes the affordance, only the tap).
    await expect(sheet.locator('[data-slot="document-read-ai"]')).toBeVisible();
  });

  test("reading through the action succeeds with no per-document consent prompt", async ({
    page,
  }) => {
    await mockDocumentCapability(page, { egress: "external" });
    let indexCalls = 0;
    await page.route(
      `**/api/documents/inbound/${AI_PROBE_DOC_ID}/index`,
      (route) => {
        indexCalls += 1;
        return fulfilJson(route, {
          data: { documentId: AI_PROBE_DOC_ID, indexed: true, tokenCount: 9 },
          error: null,
        });
      },
    );

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    const read = sheet.locator('[data-slot="document-read-ai"]');
    await expect(read).toBeVisible();
    await read.click();

    await expect(page.getByText("The AI read your document.")).toBeVisible();
    expect(indexCalls).toBe(1);
  });

  test("a local-egress read shows no external notice", async ({ page }) => {
    // A self-hosted local model never leaves the machine — no egress notice.
    await mockDocumentCapability(page, {
      egress: "local",
      pdfSupported: false,
    });

    await page.goto(`/documents?doc=${AI_PROBE_DOC_ID}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await expect(
      sheet.locator('[data-slot="document-ai-egress-notice"]'),
    ).toHaveCount(0);
  });
});
