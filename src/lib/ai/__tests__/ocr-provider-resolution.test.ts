import { describe, it, expect, vi, beforeEach } from "vitest";

// v1.22 (#90) — dedicated document-scan provider resolution.

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
}));
vi.mock("@/lib/ai/codex-oauth", () => ({
  refreshDeviceTokens: vi.fn(),
  encryptCodexCreds: vi.fn(),
  decryptCodexCreds: vi.fn(),
}));

import { resolveOcrProviderChain } from "../provider";
import { prisma } from "@/lib/db";

describe("resolveOcrProviderChain", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses the dedicated OCR provider when enabled with a key", async () => {
    // Single read: the OCR columns. The dedicated provider builds, so the main
    // chain is never resolved.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiOcrEnabled: true,
      aiOcrProvider: "OPENAI",
      aiOcrModel: "gpt-4o",
      aiOcrBaseUrl: null,
      aiOcrKeyEncrypted: "enc-key",
    } as never);

    const res = await resolveOcrProviderChain("u1");

    expect(res.dedicated).toBe(true);
    expect(res.ocrModelOverride).toBe("gpt-4o");
    expect(res.chain).toHaveLength(1);
    expect(res.chain[0].providerType).toBe("openai");
    // Only the OCR-column read happened — no main-chain resolution.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("maps LOCAL OCR provider to the local chain tag via base URL", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiOcrEnabled: true,
      aiOcrProvider: "LOCAL",
      aiOcrModel: "llava",
      aiOcrBaseUrl: "http://localhost:11434/v1",
      aiOcrKeyEncrypted: null,
    } as never);

    const res = await resolveOcrProviderChain("u1");

    expect(res.dedicated).toBe(true);
    expect(res.chain[0].providerType).toBe("local");
  });

  it("falls back to the main chain when OCR is disabled", async () => {
    // First read: OCR columns (disabled). Second read: the main provider chain
    // resolution (no enabled chain / creds) → empty main chain.
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiOcrEnabled: false,
        aiOcrProvider: null,
        aiOcrModel: null,
        aiOcrBaseUrl: null,
        aiOcrKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiProviderChain: null,
      } as never);

    const res = await resolveOcrProviderChain("u1");

    expect(res.dedicated).toBe(false);
    expect(res.ocrModelOverride).toBeNull();
    // The OCR-column read plus the main-chain resolution both ran (the
    // fallback path), so more than the single dedicated-path read happened.
    expect(
      vi.mocked(prisma.user.findUnique).mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("falls back to the main chain when enabled but the key is missing", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiOcrEnabled: true,
        aiOcrProvider: "OPENAI",
        aiOcrModel: "gpt-4o",
        aiOcrBaseUrl: null,
        aiOcrKeyEncrypted: null, // missing credential → cannot build
      } as never)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiProviderChain: null,
      } as never);

    const res = await resolveOcrProviderChain("u1");

    expect(res.dedicated).toBe(false);
  });
});
