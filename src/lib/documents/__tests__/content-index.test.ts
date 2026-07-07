import { describe, it, expect, beforeEach, vi } from "vitest";
import { Buffer } from "node:buffer";

/**
 * Blind content-search index (Document vault P2).
 *
 * Pins the token scheme's correctness (whole-word match, stopword drop,
 * de-accent, length gate, cap) AND the security invariant A4: nothing readable
 * at rest — the stored text column is ciphertext and the token array is opaque
 * HMAC output, not plaintext.
 */

// The upsert path touches prisma; the pure helpers do not, but the module
// imports @/lib/db at load, so mock it.
vi.mock("@/lib/db", () => ({
  prisma: { documentContentIndex: { upsert: vi.fn() } },
}));

import { _resetCryptoCacheForTests } from "@/lib/crypto";
import {
  CONTENT_TOKENIZER_VERSION,
  decryptIndexText,
  encryptIndexText,
  hashQueryTokens,
  normaliseIndexText,
  tokenise,
  tokeniseAndHash,
} from "../content-index";

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

beforeEach(() => {
  useKey(KEY_V1);
});

describe("normaliseIndexText", () => {
  it("lowercases and strips diacritics", () => {
    expect(normaliseIndexText("Nürnberg ÄÖÜ Café")).toBe("nurnberg aou cafe");
  });

  it("caps the stored text at the byte budget", () => {
    const huge = "a".repeat(200_000);
    expect(normaliseIndexText(huge).length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("tokenise", () => {
  it("keeps content words, drops stopwords and short tokens", () => {
    const tokens = tokenise("The patient has Diabetes and a high value");
    expect(tokens).toContain("patient");
    expect(tokens).toContain("diabetes");
    expect(tokens).toContain("high");
    expect(tokens).toContain("value");
    // stopwords + < 3 chars dropped
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("has"); // length 3 but stopword
  });

  it("de-accents so an accented body word matches its plain query", () => {
    expect(tokenise("Röntgenbefund")).toContain("rontgenbefund");
  });

  it("dedupes repeated tokens", () => {
    const tokens = tokenise("cholesterol cholesterol CHOLESTEROL");
    expect(tokens.filter((t) => t === "cholesterol")).toHaveLength(1);
  });
});

describe("tokeniseAndHash (blind index)", () => {
  it("produces opaque hex tags, never the plaintext token", () => {
    const hashes = tokeniseAndHash("hemoglobin");
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{16}$/u);
    expect(hashes[0]).not.toContain("hemoglobin");
  });

  it("is deterministic under a fixed key", () => {
    expect(tokeniseAndHash("creatinine")).toEqual(tokeniseAndHash("creatinine"));
  });

  it("a query word hashes to the same tag as the body word (whole-word hit)", () => {
    const body = tokeniseAndHash("The full blood count showed leukocytes");
    const query = hashQueryTokens("leukocytes");
    expect(query).toHaveLength(1);
    expect(body).toContain(query[0]);
  });

  it("a substring is NOT a whole-word hit (honest limit)", () => {
    const body = tokeniseAndHash("leukocytes");
    // "leuko" is a prefix, not a whole token → different tag, no overlap.
    const query = hashQueryTokens("leuko");
    expect(body.some((h) => query.includes(h))).toBe(false);
  });

  it("changes when the master key rotates (subkey follows the active key)", () => {
    const under1 = tokeniseAndHash("glucose");
    useKey(KEY_V2);
    const under2 = tokeniseAndHash("glucose");
    expect(under2).not.toEqual(under1);
  });
});

describe("encryptIndexText (no plaintext at rest — A4)", () => {
  it("round-trips and never stores the plaintext in the ciphertext bytes", () => {
    const text = "confidential diagnosis text";
    const encrypted = encryptIndexText(text);
    expect(Buffer.from(encrypted).toString("utf8")).not.toContain(text);
    expect(decryptIndexText(encrypted)).toBe(text);
  });
});

describe("tokenizer version", () => {
  it("is exported for re-index detection", () => {
    expect(CONTENT_TOKENIZER_VERSION).toBe("1");
  });
});
