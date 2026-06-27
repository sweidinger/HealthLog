import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));

import { resolveBearerToken, BearerAuthError } from "../bearer";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth/hmac";

const FAKE_HASH = "deadbeefcafef00d";
const RAW_TOKEN = "hlk_" + "a".repeat(64);
const FAKE_USER = { id: "user-1", role: "USER" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hashToken).mockReturnValue(FAKE_HASH);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
});

describe("resolveBearerToken", () => {
  it("looks the token up by HMAC hash, never the plaintext", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: new Date(Date.now() + 86_400_000),
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const res = await resolveBearerToken(RAW_TOKEN);

    expect(hashToken).toHaveBeenCalledWith(RAW_TOKEN);
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: FAKE_HASH } }),
    );
    expect(res.user.id).toBe("user-1");
    expect(res.tokenId).toBe("token-1");
    expect(res.permissions).toEqual(["*"]);
    expect(prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("rejects an unknown token (401)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null as never);
    await expect(resolveBearerToken(RAW_TOKEN)).rejects.toMatchObject({
      statusCode: 401,
      reason: "unknown_token",
    } satisfies Partial<BearerAuthError>);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a revoked token (401)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-2",
      userId: "user-1",
      permissions: [],
      revoked: true,
      expiresAt: null,
    } as never);
    await expect(resolveBearerToken(RAW_TOKEN)).rejects.toMatchObject({
      statusCode: 401,
      reason: "revoked",
    });
  });

  it("rejects an expired token (401)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-3",
      userId: "user-1",
      permissions: [],
      revoked: false,
      expiresAt: new Date(Date.now() - 60_000),
    } as never);
    await expect(resolveBearerToken(RAW_TOKEN)).rejects.toMatchObject({
      statusCode: 401,
      reason: "expired",
    });
  });

  it("rejects a narrow-scope token missing the required permission (403)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-4",
      userId: "user-1",
      permissions: ["something:else"],
      revoked: false,
      expiresAt: null,
    } as never);
    await expect(
      resolveBearerToken(RAW_TOKEN, "health:write"),
    ).rejects.toMatchObject({
      statusCode: 403,
      reason: "insufficient_permissions",
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("admits any valid token when no permission is required (REQ-SEC-5)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5",
      userId: "user-1",
      permissions: ["medication:ingest"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
    const res = await resolveBearerToken(RAW_TOKEN);
    expect(res.user.id).toBe("user-1");
  });

  it("admits a wildcard token for any required permission", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-6",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
    const res = await resolveBearerToken(RAW_TOKEN, "health:write");
    expect(res.user.id).toBe("user-1");
  });
});
