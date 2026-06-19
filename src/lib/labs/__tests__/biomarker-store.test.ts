import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests } from "@/lib/crypto";

import {
  decryptContextFromBytes,
  decryptContextSoft,
  encryptContextToBytes,
} from "../biomarker-store";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("biomarker context codec", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("ENCRYPTION_KEYS", "");
    vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
    vi.stubEnv("ENCRYPTION_KEY", KEY);
    _resetCryptoCacheForTests();
  });

  it("round-trips a UTF-8 context note through Bytes", () => {
    const plain = "Nüchtern · morgens · Lipidpanel";
    const bytes = encryptContextToBytes(plain);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decryptContextFromBytes(bytes)).toBe(plain);
  });

  it("does not store the plaintext verbatim in the bytes", () => {
    const plain = "secret context";
    const bytes = encryptContextToBytes(plain);
    const asString = Buffer.from(bytes).toString("utf8");
    expect(asString).not.toContain(plain);
  });

  describe("decryptContextSoft (fail-soft list decrypt)", () => {
    it("returns null for a null payload", () => {
      expect(decryptContextSoft(null)).toBeNull();
    });

    it("round-trips a valid payload like the throwing variant", () => {
      const bytes = encryptContextToBytes("morning fasting panel");
      expect(decryptContextSoft(bytes)).toBe("morning fasting panel");
    });

    it("returns null instead of throwing on a malformed / bad-key row", () => {
      // A non-ciphertext payload would throw in `decryptContextFromBytes`.
      const garbage = new Uint8Array(Buffer.from("not-a-ciphertext"));
      expect(() => decryptContextFromBytes(garbage)).toThrow();
      expect(decryptContextSoft(garbage)).toBeNull();
    });
  });
});
