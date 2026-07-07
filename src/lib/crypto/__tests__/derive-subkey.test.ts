import { describe, it, expect, beforeEach, vi } from "vitest";
import { Buffer } from "node:buffer";

/**
 * HKDF subkey derivation (P2-D7). The blind content index's HMAC key is derived
 * this way; the invariants that matter: deterministic under a fixed active key,
 * domain-separated by `info`, and following the active key on rotation.
 */
import { _resetCryptoCacheForTests, deriveSubkey } from "@/lib/crypto";

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_V2 =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function useKey(hexKey: string): void {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", hexKey);
  _resetCryptoCacheForTests();
}

beforeEach(() => useKey(KEY_V1));

describe("deriveSubkey", () => {
  it("returns 32 bytes", () => {
    expect(deriveSubkey("healthlog:test").byteLength).toBe(32);
  });

  it("is deterministic under a fixed active key", () => {
    expect(deriveSubkey("healthlog:test")).toEqual(deriveSubkey("healthlog:test"));
  });

  it("is domain-separated by info", () => {
    expect(deriveSubkey("healthlog:a")).not.toEqual(deriveSubkey("healthlog:b"));
  });

  it("is never the raw master key", () => {
    const master = Buffer.from(KEY_V1, "hex");
    expect(deriveSubkey("healthlog:test").equals(master)).toBe(false);
  });

  it("follows the active key on rotation", () => {
    const under1 = deriveSubkey("healthlog:test");
    useKey(KEY_V2);
    const under2 = deriveSubkey("healthlog:test");
    expect(under2).not.toEqual(under1);
  });
});
