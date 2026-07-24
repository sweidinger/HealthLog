/**
 * Shared native-handoff core — the `flow` discriminator (iOS #65).
 *
 * The mint writes the flow; the consume filters on it. A code minted by one
 * flow presented at the other's token route must resolve to the SAME generic
 * `not_found` an unknown code gets — the cross-flow boundary is structural, not
 * observational. This file is the mutation-check target for that boundary
 * (remove the flow filter in `consumeNativeHandoff` → the cross-flow cases here
 * go RED).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    oidcNativeHandoff: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn((t: string) => `H(${t.length})`),
}));

const revokeRefreshTokenByHash = vi.fn();
vi.mock("@/lib/auth/refresh-token", () => ({
  revokeRefreshTokenByHash: (h: string) => revokeRefreshTokenByHash(h),
}));

const auditLog = vi.fn();
vi.mock("@/lib/auth/audit", () => ({
  auditLog: (...a: unknown[]) => auditLog(...a),
}));

import { mintNativeHandoff, consumeNativeHandoff } from "../native-handoff";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";
import { prisma } from "@/lib/db";

const VERIFIER = "a".repeat(43);
const CHALLENGE = s256Challenge(VERIFIER);

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ho-1",
    userId: "user-1",
    codeHash: "H(47)",
    flow: "web_login",
    codeChallenge: CHALLENGE,
    expiresAt: new Date(Date.now() + 90_000),
    consumedAt: null,
    issuedRefreshTokenHash: null,
    createdAt: new Date(),
    ipAddress: "1.2.3.4",
    userAgent: "HealthLog-iOS/1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mintNativeHandoff — flow discriminator", () => {
  it("defaults to oidc so the OIDC leg's call site is unchanged", async () => {
    vi.mocked(prisma.oidcNativeHandoff.create).mockResolvedValue({
      id: "ho-1",
    } as never);
    await mintNativeHandoff({ userId: "user-1", appCodeChallenge: CHALLENGE });
    const arg = vi.mocked(prisma.oidcNativeHandoff.create).mock.calls[0][0];
    expect(arg.data.flow).toBe("oidc");
  });

  it("writes flow=web_login when the web-handoff flow mints", async () => {
    vi.mocked(prisma.oidcNativeHandoff.create).mockResolvedValue({
      id: "ho-1",
    } as never);
    await mintNativeHandoff({
      userId: "user-1",
      appCodeChallenge: CHALLENGE,
      flow: "web_login",
    });
    const arg = vi.mocked(prisma.oidcNativeHandoff.create).mock.calls[0][0];
    expect(arg.data.flow).toBe("web_login");
  });
});

describe("consumeNativeHandoff — cross-flow rejection", () => {
  it("web_login row presented as oidc → not_found (no consume, no revoke)", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({ flow: "web_login" }) as never,
    );
    const res = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      VERIFIER,
      "oidc",
    );
    expect(res.status).toBe("not_found");
    expect(prisma.oidcNativeHandoff.updateMany).not.toHaveBeenCalled();
  });

  it("oidc row presented as web_login → not_found", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({ flow: "oidc" }) as never,
    );
    const res = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      VERIFIER,
      "web_login",
    );
    expect(res.status).toBe("not_found");
  });

  it("a legacy row with no flow is treated as oidc", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({ flow: undefined }) as never,
    );
    // As oidc: passes the flow gate (falls through to consume).
    vi.mocked(prisma.oidcNativeHandoff.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const asOidc = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      VERIFIER,
      "oidc",
    );
    expect(asOidc.status).toBe("ok");

    // As web_login: rejected.
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({ flow: undefined }) as never,
    );
    const asWeb = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      VERIFIER,
      "web_login",
    );
    expect(asWeb.status).toBe("not_found");
  });

  it("same-flow (web_login) with the right verifier consumes atomically", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({ flow: "web_login" }) as never,
    );
    vi.mocked(prisma.oidcNativeHandoff.updateMany).mockResolvedValue({
      count: 1,
    } as never);
    const res = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      VERIFIER,
      "web_login",
    );
    expect(res).toEqual({ status: "ok", userId: "user-1", handoffId: "ho-1" });
  });

  it("a web_login replay audits the web-flow action name", async () => {
    vi.mocked(prisma.oidcNativeHandoff.findUnique).mockResolvedValue(
      storedRow({
        flow: "web_login",
        consumedAt: new Date(),
        issuedRefreshTokenHash: "issued-hash",
      }) as never,
    );
    const res = await consumeNativeHandoff(
      "hlh_" + "x".repeat(43),
      VERIFIER,
      "web_login",
    );
    expect(res.status).toBe("replayed");
    expect(revokeRefreshTokenByHash).toHaveBeenCalledWith("issued-hash");
    expect(auditLog).toHaveBeenCalledWith(
      "auth.native.handoff_replay",
      expect.objectContaining({ userId: "user-1" }),
    );
  });
});
