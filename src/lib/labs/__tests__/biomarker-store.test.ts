import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCryptoCacheForTests } from "@/lib/crypto";

import {
  decryptContextFromBytes,
  encryptContextToBytes,
} from "../biomarker-store";

const KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
});
