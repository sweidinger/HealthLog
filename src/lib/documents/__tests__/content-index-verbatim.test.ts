import { describe, it, expect, beforeEach, vi } from "vitest";
import { Buffer } from "node:buffer";

/**
 * Verbatim document text capture (Document vault P4).
 *
 * Pins: the verbatim capture preserves casing/accents (unlike the normalised
 * search text), stays under the byte budget, and — the security invariant — is
 * stored as AES-256-GCM CIPHERTEXT at rest, never plaintext. Also pins that
 * `upsertContentIndex` writes the verbatim column alongside the normalised one.
 */

const { upsert } = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { documentContentIndex: { upsert } },
}));

import { _resetCryptoCacheForTests } from "@/lib/crypto";
import {
  MAX_VERBATIM_TEXT_BYTES,
  captureVerbatimText,
  encryptVerbatimText,
  decryptVerbatimText,
  upsertContentIndex,
} from "../content-index";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", KEY);
  _resetCryptoCacheForTests();
});

describe("captureVerbatimText", () => {
  it("preserves casing, accents, and section names (NOT normalised)", () => {
    const raw = "Impression: Nürnberg Café — LDL 160 mg/dL";
    expect(captureVerbatimText(raw)).toBe(raw);
  });

  it("byte-caps a runaway body", () => {
    const huge = "ä".repeat(200_000);
    const out = captureVerbatimText(huge);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(
      MAX_VERBATIM_TEXT_BYTES,
    );
  });
});

describe("encryptVerbatimText (no plaintext at rest)", () => {
  it("round-trips and never stores the plaintext in the ciphertext bytes", () => {
    const text = "Diagnosis: mild elevation";
    const encrypted = encryptVerbatimText(text);
    expect(Buffer.from(encrypted).toString("utf8")).not.toContain(text);
    expect(decryptVerbatimText(encrypted)).toBe(text);
  });
});

describe("upsertContentIndex writes the verbatim column", () => {
  it("stores verbatim ciphertext that decrypts to the raw text, casing intact", async () => {
    upsert.mockResolvedValue({});
    const raw = "Impression: Mild Elevation of LDL";
    await upsertContentIndex({
      userId: "u1",
      documentId: "d1",
      text: raw,
      source: "vision",
      providerType: "anthropic",
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    const created = arg.create;
    // The verbatim column is present and is ciphertext (not the raw text bytes).
    expect(created.verbatimTextEncrypted).toBeDefined();
    expect(
      Buffer.from(created.verbatimTextEncrypted).toString("utf8"),
    ).not.toContain("Impression");
    // It decrypts back to the raw text with casing preserved.
    expect(decryptVerbatimText(created.verbatimTextEncrypted)).toBe(raw);
    // The normalised search text stays lowercased/de-accented (distinct column).
    expect(decryptVerbatimText(created.textEncrypted)).toBe(
      "impression: mild elevation of ldl",
    );
    // The update branch carries it too (idempotent re-index).
    expect(arg.update.verbatimTextEncrypted).toBeDefined();
  });
});
