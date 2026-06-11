import { expect, test } from "@playwright/test";

import { STORAGE_STATE_PATH } from "./setup/global-setup";

/**
 * Guided clarifying-questions flow on the full-page Coach route
 * (v1.16.5 — V2 of the v1.16.0 composer chips).
 *
 * Contracts under test:
 *
 *   1. With pending self-context questions, the entry card
 *      (`data-slot="coach-guided-offer"`) renders above the composer
 *      and offers start / later / don't-ask-again.
 *   2. Starting the flow mounts the first deterministic question
 *      bubble in the thread (`data-slot="coach-guided-question"`,
 *      `data-state="current"`) with the progress line and the
 *      skip / later / dismiss actions.
 *   3. Skip advances to the next question without any server write.
 *   4. "Later" mid-sequence ends the flow without a summary when
 *      nothing was answered; the entry card stays hidden for the
 *      session.
 *   5. The entry-card "later" hides the offer without touching the
 *      thread.
 *
 * The questions API is mocked — the flow itself is purely client-side
 * until an answer is sent, and no answer is sent here (the chat SSE
 * stream stays out of scope).
 */
test.describe("Coach guided clarifying questions", () => {
  test.use({ storageState: STORAGE_STATE_PATH });

  const QUESTIONS = [
    "Guided e2e question one?",
    "Guided e2e question two?",
    "Guided e2e question three?",
  ];

  test.beforeEach(async ({ page }) => {
    // Empty conversation list so the page surface paints the empty
    // thread + history rail without hitting the database.
    // Wide pattern on purpose: the list GET may fire with or without a
    // cursor query. Neither the detail GET nor the SSE POST fires in
    // this spec (no conversation is opened, no message is sent).
    await page.route("**/api/insights/chat*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { conversations: [], nextCursor: null },
          error: null,
        }),
      }),
    );
    await page.route("**/api/insights/coach/nudge-status*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { nudgedAt: null, unread: false },
          error: null,
        }),
      }),
    );
    // Pending questions: GET serves the snapshot, DELETE (dismiss one
    // or all) empties it.
    await page.route("**/api/coach/about-me/questions*", (route) => {
      const isDelete = route.request().method() === "DELETE";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { questions: isDelete ? [] : QUESTIONS },
          error: null,
        }),
      });
    });
  });

  test("offer card starts the guided sequence; skip and later walk it", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "flow logic is viewport-independent; desktop run suffices",
    );

    await page.goto("/insights/coach", { waitUntil: "domcontentloaded" });

    // 1. Entry card with the three choices.
    const offer = page.locator('[data-slot="coach-guided-offer"]');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await expect(
      offer.locator('[data-slot="coach-guided-offer-start"]'),
    ).toBeVisible();
    await expect(
      offer.locator('[data-slot="coach-guided-offer-later"]'),
    ).toBeVisible();
    await expect(
      offer.locator('[data-slot="coach-guided-offer-dismiss"]'),
    ).toBeVisible();

    // 2. Start → first question bubble (typing reveal lasts <1s).
    await offer.locator('[data-slot="coach-guided-offer-start"]').click();
    await expect(offer).toHaveCount(0);
    const question = page.locator(
      '[data-slot="coach-guided-question"][data-state="current"]',
    );
    await expect(question).toBeVisible({ timeout: 10_000 });
    await expect(question).toContainText(QUESTIONS[0], { timeout: 10_000 });
    await expect(
      question.locator('[data-slot="coach-guided-progress"]'),
    ).toContainText("1");

    // 3. Skip → second question, original numbering.
    await question.locator('[data-slot="coach-guided-skip"]').click();
    await expect(question).toContainText(QUESTIONS[1], { timeout: 10_000 });
    await expect(
      question.locator('[data-slot="coach-guided-progress"]'),
    ).toContainText("2");

    // 4. Later mid-sequence → flow ends, nothing answered → no summary,
    //    no question bubble, and the offer stays hidden for the session.
    await question.locator('[data-slot="coach-guided-later"]').click();
    await expect(
      page.locator('[data-slot="coach-guided-question"]'),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-slot="coach-guided-summary"]'),
    ).toHaveCount(0);
    await expect(offer).toHaveCount(0);
  });

  test("entry-card later hides the offer without starting the flow", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium-desktop",
      "flow logic is viewport-independent; desktop run suffices",
    );

    await page.goto("/insights/coach", { waitUntil: "domcontentloaded" });

    const offer = page.locator('[data-slot="coach-guided-offer"]');
    await expect(offer).toBeVisible({ timeout: 10_000 });
    await offer.locator('[data-slot="coach-guided-offer-later"]').click();
    await expect(offer).toHaveCount(0);
    await expect(
      page.locator('[data-slot="coach-guided-question"]'),
    ).toHaveCount(0);
  });
});
