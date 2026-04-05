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
  refreshAccessToken: vi.fn(),
  encryptTokens: vi.fn((t: { accessToken: string; refreshToken: string }) => ({ accessEncrypted: `enc:${t.accessToken}`, refreshEncrypted: `enc:${t.refreshToken}` })),
  decryptTokens: vi.fn(),
}));

import { resolveProvider } from "../provider";
import { prisma } from "@/lib/db";
import { decryptTokens } from "@/lib/ai/codex-oauth";

describe("resolveProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns codex provider when user has valid tokens", async () => {
    vi.mocked(decryptTokens).mockReturnValue({
      accessToken: "decrypted-access",
      refreshToken: "decrypted-refresh",
    });

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      codexAccessTokenEncrypted: "enc-access",
      codexRefreshTokenEncrypted: "enc-refresh",
      codexTokenExpiresAt: new Date(Date.now() + 3600000),
      codexConnectionStatus: "connected",
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("codex");
  });

  it("returns admin-key when user has no codex but admin key exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
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
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      codexAccessTokenEncrypted: null,
      codexConnectionStatus: "disconnected",
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
    } as never);

    const provider = await resolveProvider("user-123");
    expect(provider.type).toBe("none");
  });

  it("falls back to admin-key when codex status is expired", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
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
});
