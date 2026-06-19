/**
 * v1.18.7 — share-link passphrase second factor.
 *
 * Asserts: generated passphrases match the grouped human-typeable form and are
 * high-entropy / unique; normalisation collapses grouped and bare forms to one
 * canonical hash; verification is correct, rejects a wrong passphrase, and a
 * null stored hash; a malformed submission is rejected without throwing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const TEST_HMAC_KEY = "test-hmac-key-at-least-32-chars-long-xxxxx";

beforeEach(() => {
  vi.stubEnv("API_TOKEN_HMAC_KEY", TEST_HMAC_KEY);
});

import {
  generatePassphrase,
  hashPassphrase,
  normalisePassphrase,
  verifyPassphrase,
  PASSPHRASE_PATTERN,
} from "../passphrase";

describe("generatePassphrase", () => {
  it("emits the grouped XXXX-XXXX-XXXX-XXXX form", () => {
    const p = generatePassphrase();
    expect(p).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    // The bare form is 16 Crockford-base32 chars (80 bits).
    expect(normalisePassphrase(p)).toMatch(PASSPHRASE_PATTERN);
  });

  it("excludes the easily-confused I/L/O/U letters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePassphrase()).not.toMatch(/[ILOU]/);
    }
  });

  it("is unique across a sample (high entropy)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generatePassphrase());
    expect(seen.size).toBe(200);
  });
});

describe("normalisePassphrase", () => {
  it("collapses grouped, spaced, and lowercase forms to one canonical value", () => {
    const p = generatePassphrase();
    const bare = normalisePassphrase(p)!;
    expect(normalisePassphrase(bare)).toBe(bare);
    expect(normalisePassphrase(p.toLowerCase())).toBe(bare);
    expect(normalisePassphrase(p.replace(/-/g, " "))).toBe(bare);
  });

  it("rejects a malformed value", () => {
    expect(normalisePassphrase("not a passphrase!")).toBeNull();
    expect(normalisePassphrase("")).toBeNull();
    // Contains an excluded letter.
    expect(normalisePassphrase("IIII-IIII-IIII-IIII")).toBeNull();
  });
});

describe("verifyPassphrase", () => {
  it("accepts the correct passphrase against its stored hash", () => {
    const p = generatePassphrase();
    const hash = hashPassphrase(normalisePassphrase(p)!);
    expect(verifyPassphrase(p, hash)).toBe(true);
    // Grouped vs bare vs lowercase all verify against the one hash.
    expect(verifyPassphrase(normalisePassphrase(p)!, hash)).toBe(true);
    expect(verifyPassphrase(p.toLowerCase(), hash)).toBe(true);
  });

  it("rejects a wrong passphrase", () => {
    const hash = hashPassphrase(normalisePassphrase(generatePassphrase())!);
    expect(verifyPassphrase(generatePassphrase(), hash)).toBe(false);
  });

  it("rejects against a null stored hash (legacy / unset)", () => {
    expect(verifyPassphrase(generatePassphrase(), null)).toBe(false);
  });

  it("rejects a malformed submission without throwing", () => {
    const hash = hashPassphrase(normalisePassphrase(generatePassphrase())!);
    expect(verifyPassphrase("garbage", hash)).toBe(false);
    expect(verifyPassphrase("", hash)).toBe(false);
  });
});
