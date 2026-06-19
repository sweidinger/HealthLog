/**
 * v1.18.7 — short-lived, token-scoped unlock cookie.
 *
 * Asserts: a minted value verifies against its own token hash; it does NOT
 * verify against a different token hash (cross-token isolation); an expired
 * value is rejected; a forged / malformed value is rejected; the cookie name
 * is per-token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TEST_HMAC_KEY = "test-hmac-key-at-least-32-chars-long-xxxxx";

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HMAC_KEY", TEST_HMAC_KEY);
});
afterEach(() => {
  vi.useRealTimers();
});

import {
  mintUnlockValue,
  verifyUnlockValue,
  unlockCookieName,
  UNLOCK_TTL_SECONDS,
} from "../unlock-cookie";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("unlock-cookie", () => {
  it("verifies a freshly-minted value against its own token hash", () => {
    const value = mintUnlockValue(HASH_A);
    expect(verifyUnlockValue(value, HASH_A)).toBe(true);
  });

  it("does NOT verify against a different token hash (cross-token isolation)", () => {
    const value = mintUnlockValue(HASH_A);
    expect(verifyUnlockValue(value, HASH_B)).toBe(false);
  });

  it("rejects an expired value", () => {
    vi.useFakeTimers();
    const value = mintUnlockValue(HASH_A);
    // Advance past the TTL.
    vi.advanceTimersByTime((UNLOCK_TTL_SECONDS + 60) * 1000);
    expect(verifyUnlockValue(value, HASH_A)).toBe(false);
  });

  it("rejects a forged or malformed value", () => {
    expect(verifyUnlockValue(undefined, HASH_A)).toBe(false);
    expect(verifyUnlockValue("", HASH_A)).toBe(false);
    expect(verifyUnlockValue("nodot", HASH_A)).toBe(false);
    expect(
      verifyUnlockValue(`${Date.now() + 1_000_000}.deadbeef`, HASH_A),
    ).toBe(false);
  });

  it("derives a per-token cookie name", () => {
    expect(unlockCookieName(HASH_A)).not.toBe(unlockCookieName(HASH_B));
    expect(unlockCookieName(HASH_A)).toMatch(/^hls_unlock_/);
  });
});
