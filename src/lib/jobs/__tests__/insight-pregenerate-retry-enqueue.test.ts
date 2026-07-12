/**
 * v1.28.30 — bounded intra-day retry for a failed nightly comprehensive
 * warm. Pins the enqueue contract: delayed start (~45 min), per-user
 * singleton key distinct from the on-demand `force:` key, small retry
 * policy, and a clean no-op (no throw) when no boss instance exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn();
let boss: { send: typeof send } | null = null;

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => boss,
}));

import {
  enqueuePregenerateFailureRetry,
  PREGENERATE_RETRY_DELAY_SECONDS,
  INSIGHT_PREGENERATE_QUEUE,
} from "../insight-pregenerate-shared";

beforeEach(() => {
  vi.clearAllMocks();
  boss = { send };
});

describe("enqueuePregenerateFailureRetry", () => {
  it("enqueues one delayed forced single-user warm with a per-user retry singleton", async () => {
    await enqueuePregenerateFailureRetry({ userId: "u1", locale: "de" });

    expect(send).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(queue).toBe(INSIGHT_PREGENERATE_QUEUE);
    // Same forced single-user payload the on-demand warm uses, so the
    // worker routes it through `forceWarmUser` (freshness re-check,
    // failure backoff, daily cap all apply at execution time).
    expect(payload).toEqual({ userId: "u1", force: true, locale: "de" });
    // Delayed so a transient nightly hiccup has time to clear; distinct
    // singleton key so a page-open force warm cannot swallow the retry.
    expect(options.startAfter).toBe(PREGENERATE_RETRY_DELAY_SECONDS);
    expect(options.singletonKey).toBe("retry:u1");
  });

  it("keeps the retry window inside the same morning (30-60 min)", () => {
    expect(PREGENERATE_RETRY_DELAY_SECONDS).toBeGreaterThanOrEqual(30 * 60);
    expect(PREGENERATE_RETRY_DELAY_SECONDS).toBeLessThanOrEqual(60 * 60);
  });

  it("no-ops without throwing when no boss instance is available", async () => {
    boss = null;
    await expect(
      enqueuePregenerateFailureRetry({ userId: "u1", locale: "en" }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a send failure (best-effort; the nightly tick stays the catch-net)", async () => {
    send.mockRejectedValueOnce(new Error("boss unavailable"));
    await expect(
      enqueuePregenerateFailureRetry({ userId: "u1", locale: "de" }),
    ).resolves.toBeUndefined();
  });
});
