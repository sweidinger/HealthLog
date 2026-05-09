import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedCodexSlug,
  setCachedCodexSlug,
  invalidateCachedCodexSlug,
  clearCodexSlugCache,
  inspectCodexSlugCache,
  CODEX_SLUG_CACHE_TTL_MS,
} from "../codex-slug-cache";

/**
 * Phase C1 — slug-drift defence positive cache.
 * Cache TTL = 1 hour per `docs/codex-protocol-spec.md` §7b.
 */
describe("Codex slug cache", () => {
  beforeEach(() => {
    clearCodexSlugCache();
  });

  it("starts empty", () => {
    expect(getCachedCodexSlug()).toBeNull();
    expect(inspectCodexSlugCache()).toBeNull();
  });

  it("set + get returns the cached slug within TTL", () => {
    setCachedCodexSlug("gpt-5.3-codex", 1_000);
    expect(getCachedCodexSlug(1_000)).toBe("gpt-5.3-codex");
    expect(getCachedCodexSlug(1_000 + CODEX_SLUG_CACHE_TTL_MS - 1)).toBe(
      "gpt-5.3-codex",
    );
  });

  it("expires entries strictly after the TTL", () => {
    setCachedCodexSlug("gpt-5.3-codex", 1_000);
    // Exactly at TTL: still valid (the comparison is `now - cached > TTL`).
    expect(getCachedCodexSlug(1_000 + CODEX_SLUG_CACHE_TTL_MS)).toBe(
      "gpt-5.3-codex",
    );
    // Past TTL: gone.
    expect(getCachedCodexSlug(1_000 + CODEX_SLUG_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("expired entry is evicted on read", () => {
    setCachedCodexSlug("gpt-5.3-codex", 1_000);
    getCachedCodexSlug(1_000 + CODEX_SLUG_CACHE_TTL_MS + 1);
    // Subsequent inspect should be null too.
    expect(inspectCodexSlugCache(1_000 + CODEX_SLUG_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("invalidate clears the slot", () => {
    setCachedCodexSlug("gpt-5.3-codex");
    invalidateCachedCodexSlug();
    expect(getCachedCodexSlug()).toBeNull();
  });

  it("set replaces the previous slot", () => {
    setCachedCodexSlug("a", 1_000);
    setCachedCodexSlug("b", 2_000);
    expect(getCachedCodexSlug(2_500)).toBe("b");
  });

  it("inspect reports age in ms", () => {
    setCachedCodexSlug("gpt-5.3-codex", 1_000);
    const inspected = inspectCodexSlugCache(1_500);
    expect(inspected).toEqual({ slug: "gpt-5.3-codex", ageMs: 500 });
  });
});
