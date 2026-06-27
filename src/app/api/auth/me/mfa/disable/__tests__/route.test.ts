import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    requireFreshMfa: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    user: { update: vi.fn() },
    mfaRecoveryCode: { deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  destroyOtherSessions: vi.fn().mockResolvedValue({ sessionsRevoked: 2 }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/mfa/verify-factor", () => ({
  verifyMfaFactor: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

import { POST } from "../route";
import { requireFreshMfa } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { destroyOtherSessions } from "@/lib/auth/session";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";

function req() {
  return new Request("http://localhost/api/auth/me/mfa/disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "totp", code: "123456" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireFreshMfa).mockResolvedValue({
    user: { id: "u1" },
    session: { id: "sess-current" },
  } as never);
  vi.mocked(verifyMfaFactor).mockResolvedValue({ ok: true } as never);
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => {
    if (typeof cb === "function") {
      return (cb as (tx: unknown) => unknown)({
        user: { update: vi.fn() },
        mfaRecoveryCode: { deleteMany: vi.fn() },
      });
    }
    return undefined;
  });
});

describe("POST /api/auth/me/mfa/disable", () => {
  it("revokes other sessions + trusted devices (via destroyOtherSessions), keeping the current one", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(destroyOtherSessions).toHaveBeenCalledWith("u1", "sess-current");
  });

  it("rejects a wrong current factor without revoking anything", async () => {
    vi.mocked(verifyMfaFactor).mockResolvedValue({
      ok: false,
      replay: false,
    } as never);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(destroyOtherSessions).not.toHaveBeenCalled();
  });
});
