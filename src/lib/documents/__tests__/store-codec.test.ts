import { describe, it, expect, beforeEach, vi } from "vitest";
import { Buffer } from "node:buffer";

/**
 * Document content codec dispatch: new uploads write "binary2", pre-vault
 * rows keep decoding via the legacy "base64v1" string path, and an unknown
 * codec value fails closed instead of guessing.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

import { _resetCryptoCacheForTests } from "@/lib/crypto";
import {
  ACTIVE_DOCUMENT_CODEC,
  decryptDocumentContent,
  decryptDocumentFromBytes,
  encryptDocumentContent,
  encryptDocumentToBytes,
} from "../store";

const KEY_V1 =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const SAMPLE = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from([0x00, 0xff, 0x80, 0x7f]),
  Buffer.alloc(2048, 0xab),
]);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY_V1);
  _resetCryptoCacheForTests();
});

describe("document content codecs", () => {
  it("writes new uploads with the binary2 codec and round-trips them", () => {
    const { content, codec } = encryptDocumentContent(SAMPLE);
    expect(codec).toBe("binary2");
    expect(codec).toBe(ACTIVE_DOCUMENT_CODEC);
    expect(Buffer.from(content).equals(SAMPLE)).toBe(false);
    expect(decryptDocumentContent(content, codec).equals(SAMPLE)).toBe(true);
  });

  it("still decodes legacy base64v1 rows byte-identically", () => {
    // A pre-vault row: base64-of-binary → encrypt() string → UTF-8 bytes.
    const legacy = encryptDocumentToBytes(SAMPLE);
    expect(decryptDocumentContent(legacy, "base64v1").equals(SAMPLE)).toBe(
      true,
    );
    // The legacy helper itself stays the exact inverse.
    expect(decryptDocumentFromBytes(legacy).equals(SAMPLE)).toBe(true);
  });

  it("binary2 is ~25 % smaller at rest than the base64 detour", () => {
    const legacy = encryptDocumentToBytes(SAMPLE);
    const { content } = encryptDocumentContent(SAMPLE);
    expect(content.byteLength).toBeLessThan(legacy.byteLength * 0.8);
  });

  it("fails closed on an unknown codec value", () => {
    const { content } = encryptDocumentContent(SAMPLE);
    expect(() => decryptDocumentContent(content, "codec9")).toThrow(
      /unknown document content codec/i,
    );
    expect(() => decryptDocumentContent(content, "")).toThrow();
  });

  it("fails closed when codecs are crossed (no silent fallback)", () => {
    const legacy = encryptDocumentToBytes(SAMPLE);
    const { content: binary } = encryptDocumentContent(SAMPLE);
    // Legacy bytes read as binary2 → header parse fails.
    expect(() => decryptDocumentContent(legacy, "binary2")).toThrow();
    // Binary bytes read as base64v1 → string decrypt fails.
    expect(() => decryptDocumentContent(binary, "base64v1")).toThrow();
  });
});
