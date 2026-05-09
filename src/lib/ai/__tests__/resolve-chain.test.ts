import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
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

import { resolveProviderChain } from "../provider";
import { prisma } from "@/lib/db";
import { decryptCodexCreds } from "@/lib/ai/codex-oauth";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveProviderChain", () => {
  it("returns the default chain when user.aiProviderChain is null", async () => {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      accessToken: "tok",
      refreshToken: "ref",
      accountId: "acct",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    vi.mocked(prisma.user.findUnique)
      // user-level config read
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiProviderChain: null,
      } as never)
      // codex tokens read
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-a",
        codexRefreshTokenEncrypted: "enc-r",
        codexTokenExpiresAt: new Date(Date.now() + 3600_000),
        codexConnectionStatus: "connected",
      } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const chain = await resolveProviderChain("user-1");
    // Default chain trims out entries with no creds; codex (tokens
    // present) and admin-openai (key present) survive.
    const types = chain.map((c) => c.providerType);
    expect(types).toContain("codex");
    expect(types).toContain("admin-openai");
    // No anthropic/local/openai key configured → those entries dropped.
    expect(types).not.toContain("anthropic");
    expect(types).not.toContain("local");
    expect(types).not.toContain("openai");
  });

  it("respects user-defined chain priority order", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: "enc-anth",
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "enc-openai",
        // user puts openai first, anthropic second; admin disabled
        aiProviderChain: [
          { providerType: "openai", priority: 1, enabled: true },
          { providerType: "anthropic", priority: 2, enabled: true },
          { providerType: "admin-openai", priority: 3, enabled: false },
        ],
      } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const chain = await resolveProviderChain("user-1");
    const types = chain.map((c) => c.providerType);
    expect(types).toEqual(["openai", "anthropic"]);
  });

  it("filters out chain entries the user has not credentialed", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null, // no anthropic key
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "enc-openai",
        aiProviderChain: [
          { providerType: "anthropic", priority: 1, enabled: true },
          { providerType: "openai", priority: 2, enabled: true },
        ],
      } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const chain = await resolveProviderChain("user-1");
    const types = chain.map((c) => c.providerType);
    expect(types).toEqual(["openai"]);
  });

  it("skips disabled entries even if the credential is present", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "enc-openai",
        aiProviderChain: [
          { providerType: "openai", priority: 1, enabled: false }, // disabled
          { providerType: "admin-openai", priority: 2, enabled: true },
        ],
      } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const chain = await resolveProviderChain("user-1");
    const types = chain.map((c) => c.providerType);
    expect(types).toEqual(["admin-openai"]);
  });

  it("returns an empty array when nothing is configured at all", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiProviderChain: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectionStatus: "disconnected",
      } as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const chain = await resolveProviderChain("user-1");
    expect(chain).toEqual([]);
  });
});
