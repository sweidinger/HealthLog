import { describe, it, expect, vi, beforeEach } from "vitest";

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
  refreshTokens: vi.fn(),
  encryptCodexCreds: vi.fn((c: { apiKey: string; refreshToken: string }) => ({
    apiKeyEncrypted: `enc:${c.apiKey}`,
    refreshEncrypted: `enc:${c.refreshToken}`,
  })),
  decryptCodexCreds: vi.fn(),
}));

import { resolveProvider } from "../provider";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { decryptCodexCreds, encryptCodexCreds } from "@/lib/ai/codex-oauth";

/**
 * resolveProvider() makes up to TWO findUnique calls per invocation:
 *   1. Read user-level AI config (aiProvider/...).
 *   2. If falling back to codex, read codex token fields.
 * We use mockResolvedValueOnce in order so each call returns the right shape.
 */

describe("resolveProvider", () => {
  beforeEach(() => {
    // Reset mocks AND mockResolvedValueOnce queues, then re-establish
    // the deterministic factory implementations for crypto/oauth helpers.
    vi.resetAllMocks();
    vi.mocked(decrypt).mockImplementation((v: string) => `decrypted:${v}`);
    vi.mocked(encrypt).mockImplementation((v: string) => `encrypted:${v}`);
    vi.mocked(encryptCodexCreds).mockImplementation(
      (c: { apiKey: string; refreshToken: string }) => ({
        apiKeyEncrypted: `enc:${c.apiKey}`,
        refreshEncrypted: `enc:${c.refreshToken}`,
      }),
    );
  });

  it("returns codex provider when user has valid tokens (no explicit choice)", async () => {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      apiKey: "sk-codex-key",
      refreshToken: "decrypted-refresh",
    });

    vi.mocked(prisma.user.findUnique)
      // 1st call: user AI config — none selected
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      // 2nd call: codex tokens
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexTokenExpiresAt: new Date(Date.now() + 3600000),
        codexConnectionStatus: "connected",
      } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("codex");
  });

  it("returns admin-key when user has no codex but admin key exists", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectionStatus: "disconnected",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin-key",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns none when nothing is configured", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectionStatus: "disconnected",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("none");
  });

  it("falls back to admin-key when codex status is expired", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: null,
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexTokenExpiresAt: new Date(Date.now() - 1000),
        codexConnectionStatus: "expired",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns Anthropic provider when user picks ANTHROPIC and has key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "ANTHROPIC",
      aiModel: "claude-3-5-sonnet-latest",
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: "enc-anthropic-key",
      aiLocalKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("anthropic");
    // Codex/admin lookups must NOT happen when user provider resolved.
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
  });

  it("falls back when user picks ANTHROPIC but has no key", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: "ANTHROPIC",
        aiModel: "claude-3-5-sonnet-latest",
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: null,
        codexConnectionStatus: "disconnected",
      } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    // ANTHROPIC explicit choice ≠ CHATGPT_OAUTH/null → codex branch is skipped.
    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("returns Local provider when user picks LOCAL with baseUrl", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "LOCAL",
      aiModel: "llama3:8b",
      aiBaseUrl: "http://localhost:11434/v1",
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("local");
  });

  it("OPENAI selection routes through admin OpenAI key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "OPENAI",
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc-admin",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
  });

  it("OPENAI with user key ignores stored aiBaseUrl (provider-leak guard)", async () => {
    // Regression for v1.4.6 T4: a user who had configured LOCAL with a
    // private LAN URL and later switched to OPENAI must NOT have their
    // OpenAI key forwarded to that URL. The persisted `aiBaseUrl` is
    // shared across providers, so `buildUserProvider` hardcodes
    // api.openai.com for OPENAI regardless of what the column carries.
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "OPENAI",
      aiModel: null,
      aiBaseUrl: "http://192.168.0.42/v1", // stale LOCAL value
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-user-openai-key",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("admin-key");
    const inspect = provider as unknown as {
      config: { baseUrl: string };
    };
    expect(inspect.config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("ANTHROPIC ignores stored aiBaseUrl (provider-leak guard)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      aiProvider: "ANTHROPIC",
      aiModel: "claude-3-5-sonnet-latest",
      aiBaseUrl: "http://192.168.0.42/v1", // stale LOCAL value
      aiAnthropicKeyEncrypted: "enc-user-anthropic-key",
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("anthropic");
    // AnthropicClient should default to its SDK baseUrl, never the LAN URL.
    const inspect = provider as unknown as {
      config: { baseUrl?: string };
    };
    expect(inspect.config.baseUrl).toBeUndefined();
  });

  it("CHATGPT_OAUTH selection routes through Codex when connected", async () => {
    vi.mocked(decryptCodexCreds).mockReturnValue({
      apiKey: "sk-codex-key",
      refreshToken: "decrypted-refresh",
    });

    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({
        aiProvider: "CHATGPT_OAUTH",
        aiModel: null,
        aiBaseUrl: null,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
      } as never)
      .mockResolvedValueOnce({
        codexAccessTokenEncrypted: "enc-access",
        codexRefreshTokenEncrypted: "enc-refresh",
        codexTokenExpiresAt: new Date(Date.now() + 3600000),
        codexConnectionStatus: "connected",
      } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("codex");
  });
});
