/**
 * Document vault — the "chat about a document" entry point (v1.28.51, R3).
 *
 * The bespoke in-sheet chat drawer is gone (Documents R3, Design A). Asking the
 * Coach about a document now hands off to the REAL Coach, scoped to that
 * document: the detail sheet's Coach affordance navigates to `/coach?doc=<id>`,
 * where the conversation runs on the same hardened fenced endpoint but inside
 * the Coach's own surface and history.
 *
 * This suite pins the documents-side contract: the affordance is offered only
 * when a provider is available, and it navigates to the doc-scoped Coach; with
 * NO provider the AI area collapses to the settings pointer and no Coach entry
 * renders at all. The Coach-side rendering (the "Chatting about" scope banner +
 * the not-indexed hint) is covered by the coach-conversation component test; the
 * fenced-send guarantee (a document turn never reaches the tool route) by the
 * coach-send-target + persistence-scope unit tests.
 *
 * v1.27.31 lesson kept: the sheet's AI area depends on the capability probe +
 * usage endpoints, so both are mocked — otherwise the AI area never renders and
 * the specs time out. The seeded demo user has no AI provider, so the
 * no-provider state is the default.
 */
import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";
import {
  ensureVaultFixture,
  ensureVaultAiFixture,
  CONTENT_DOC_ID,
} from "./setup/vault-fixture";

/** Fulfil the envelope shape the client unwraps (`(await res.json()).data`). */
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

/** The vault usage DTO the sheet reads to gate the AI affordances. */
function usageBody() {
  return {
    data: {
      usedBytes: 4096,
      quotaBytes: 1_073_741_824,
      maxFileBytes: 26_214_400,
      acceptedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".webp"],
      linkedEpisodes: [],
      assistAvailable: true,
      contentIndex: { enabled: true, indexedCount: 1, totalCount: 2 },
    },
    error: null,
  };
}

/**
 * Mock the AI-availability surface (usage + the document-scoped capability
 * probe) so the sheet offers the AI area and the Coach entry.
 */
async function mockAiEnabled(page: Page): Promise<void> {
  await page.route("**/api/documents/inbound/usage", (route) =>
    fulfilJson(route, usageBody()),
  );
  await page.route("**/api/documents/inbound/capability", (route) =>
    fulfilJson(route, {
      data: {
        available: true,
        mode: "vision",
        reason: null,
        pdfSupported: true,
        egress: "external",
      },
      error: null,
    }),
  );
  await page.route("**/api/auth/me/documents-auto-ai-read", (route) =>
    fulfilJson(route, { data: { documentsAutoAiRead: false }, error: null }),
  );
}

test.describe("document vault — chat about a document", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test.beforeAll(async () => {
    await ensureVaultFixture();
    await ensureVaultAiFixture();
  });

  test.beforeEach(() => {
    test.slow();
  });

  // ── (a) Provider available: the Coach entry hands off to the doc-scoped Coach ──

  test("offers the Coach entry and hands off to the document-scoped Coach", async ({
    page,
  }) => {
    await mockAiEnabled(page);

    await page.goto(`/documents?doc=${CONTENT_DOC_ID}`);
    const sheet = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(sheet).toBeVisible();

    // The neutral Coach affordance lives in the detail-sheet AI area; tapping it
    // navigates to the real Coach seeded with this document.
    const open = sheet.locator('[data-slot="document-chat-open"]');
    await expect(open).toBeVisible();
    await open.click();

    // The documents-side contract: the URL hands off to the doc-scoped Coach.
    await page.waitForURL(new RegExp(`/coach\\?doc=${CONTENT_DOC_ID}`));
    expect(new URL(page.url()).searchParams.get("doc")).toBe(CONTENT_DOC_ID);
  });

  // ── (b) No provider: the calm settings pointer, no Coach entry at all ──

  test("with no provider there is no Coach entry, only the settings pointer", async ({
    page,
  }) => {
    // No mocks — the seeded demo user has no AI provider configured, so the AI
    // area collapses to the calm pointer and the Coach entry never renders.
    await page.goto(`/documents?doc=${CONTENT_DOC_ID}`);
    const sheet = page.locator('[data-slot="responsive-sheet-content"]');
    await expect(sheet).toBeVisible();

    await expect(
      sheet.locator('[data-slot="assist-unavailable"]'),
    ).toBeVisible();
    await expect(
      sheet.getByRole("link", { name: "Open AI settings" }),
    ).toBeVisible();
    await expect(sheet.locator('[data-slot="document-chat-open"]')).toHaveCount(
      0,
    );
  });
});
