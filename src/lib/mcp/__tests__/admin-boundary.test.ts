/**
 * Guard: the MCP / Bearer wire can never reach an admin surface (REQ-SEC-7,
 * ADR-005).
 *
 * `requireAdmin()` authorises off a cookie session ONLY. The MCP transports
 * authenticate by Bearer token and never mint a cookie session, so in an MCP
 * process `getSession()` is always null and `requireAdmin()` always rejects —
 * regardless of the token's scope (even `["*"]`). This test pins that structural
 * boundary so a future change that softens it fails loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { requireAdmin } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("requireAdmin is cookie-only — MCP/Bearer cannot elevate", () => {
  it("rejects with 401 when there is no cookie session (the MCP reality)", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    // Even with a Bearer header present, requireAdmin must not consult it.
    headersGet.mockImplementation((name) =>
      name.toLowerCase() === "authorization"
        ? `Bearer hlk_${"a".repeat(64)}`
        : null,
    );

    await expect(requireAdmin()).rejects.toMatchObject({ statusCode: 401 });
    // The token table is never touched — admin auth ignores Bearer entirely.
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-admin cookie session with 403", async () => {
    vi.mocked(getSession).mockResolvedValue({
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 3600_000) },
      user: { id: "user-1", role: "USER" },
    } as never);

    await expect(requireAdmin()).rejects.toMatchObject({ statusCode: 403 });
  });
});
