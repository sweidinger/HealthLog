import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * v1.4.16 phase B2 — AI provider settings UX with single dropdown
 * driving the form below. Three things to lock in here:
 *
 *   1. /settings/ai exposes the active-provider Pulldown
 *      (`data-testid="ai-active-provider-select"`).
 *   2. Switching the dropdown changes the rendered config form below
 *      it: Codex form vs. OpenAI form vs. Anthropic form vs. Local
 *      form. Each form carries a stable `data-testid` so we don't
 *      lean on i18n labels.
 *   3. The fallback chain card surfaces with stable
 *      `data-chain-row="<providerType>"` markers per row.
 */
test.describe("Settings → AI provider dropdown UX (B2)", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  test("dropdown switch changes the rendered config form", async ({ page }) => {
    // Stable mocks for every endpoint the section reads. The chain
    // mirrors the default order (codex first) so the rows render
    // deterministically and the dropdown defaults to codex.
    await page.route("**/api/insights/settings", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            codexStatus: "disconnected",
            codexConnectedAt: null,
            hasAdminKey: false,
            codexOauthConfigured: true,
            privacyMode: "aggregated",
            lastInsightAt: null,
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/user/ai-provider", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            provider: null,
            model: null,
            baseUrl: null,
            hasAnthropicKey: false,
            anthropicKeyPreview: null,
            hasLocalKey: false,
            hasOpenaiKey: false,
            openaiKeyPreview: null,
          },
          error: null,
        }),
      }),
    );

    await page.route("**/api/insights/provider-chain", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            activeProvider: "codex",
            cachedActiveProvider: null,
            configuredChain: [
              { providerType: "codex", available: true },
              { providerType: "openai", available: true },
              { providerType: "anthropic", available: true },
              { providerType: "local", available: true },
            ],
          },
          error: null,
        }),
      }),
    );

    await page.goto("/settings/ai", { waitUntil: "domcontentloaded" });

    // 1. Dropdown surfaces on the page.
    const select = page.getByTestId("ai-active-provider-select");
    await expect(select).toBeVisible({ timeout: 10_000 });

    // 2a. Default → Codex form rendered.
    await expect(page.getByTestId("ai-provider-config-codex")).toBeVisible();
    await expect(page.getByTestId("ai-provider-config-openai")).toHaveCount(0);

    // 2b. Switch to OpenAI → OpenAI form rendered, Codex form gone.
    await select.selectOption("openai");
    await expect(page.getByTestId("ai-provider-config-openai")).toBeVisible();
    await expect(page.getByTestId("ai-provider-config-codex")).toHaveCount(0);
    await expect(page.getByTestId("ai-openai-api-key")).toBeVisible();
    await expect(page.getByTestId("ai-openai-model")).toBeVisible();

    // 2c. Switch to Anthropic → Anthropic form rendered.
    await select.selectOption("anthropic");
    await expect(
      page.getByTestId("ai-provider-config-anthropic"),
    ).toBeVisible();

    // 2d. Switch to Local → Local form rendered.
    await select.selectOption("local");
    await expect(page.getByTestId("ai-provider-config-local")).toBeVisible();

    // 3. Fallback chain card surfaces with the four chain rows.
    await expect(page.getByTestId("ai-fallback-chain")).toBeVisible();
    for (const slug of ["codex", "openai", "anthropic", "local"]) {
      await expect(page.locator(`[data-chain-row="${slug}"]`)).toBeVisible();
    }
  });
});
