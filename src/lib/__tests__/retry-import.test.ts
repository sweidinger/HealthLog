/**
 * Unit tests for the lazy-chunk import retry wrapper.
 *
 * A rejected `import()` inside `React.lazy` / `next/dynamic` caches its
 * rejection permanently, so the wrapper must absorb ONE transient
 * failure (stale shell right after a deploy, flaky network) before the
 * rejection reaches the boundary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { IMPORT_RETRY_DELAY_MS, importWithRetry } from "../retry-import";

afterEach(() => {
  vi.useRealTimers();
});

describe("importWithRetry", () => {
  it("resolves immediately when the first attempt succeeds", async () => {
    const importer = vi.fn().mockResolvedValue({ default: "ok" });

    await expect(importWithRetry(importer)).resolves.toEqual({
      default: "ok",
    });
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("retries once after the delay when the first attempt rejects", async () => {
    vi.useFakeTimers();
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("Loading chunk 42 failed"))
      .mockResolvedValueOnce({ default: "ok" });

    const promise = importWithRetry(importer);
    // The retry must not fire before the delay elapses.
    await vi.advanceTimersByTimeAsync(IMPORT_RETRY_DELAY_MS - 1);
    expect(importer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(promise).resolves.toEqual({ default: "ok" });
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("rejects with the original error once the retry budget is spent", async () => {
    vi.useFakeTimers();
    const chunkError = new Error("Loading chunk 42 failed");
    const importer = vi.fn().mockRejectedValue(chunkError);

    const promise = importWithRetry(importer);
    promise.catch(() => undefined); // pre-attach so the rejection is handled
    await vi.advanceTimersByTimeAsync(IMPORT_RETRY_DELAY_MS);

    await expect(promise).rejects.toBe(chunkError);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
