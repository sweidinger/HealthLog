import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/api-handler";

const ADMIN_CTX = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "admin-1", username: "admin", role: "ADMIN" } as never,
};

function req(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/audit-log${query ? "?" + query : ""}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
  vi.mocked(prisma.auditLog.count).mockResolvedValue(0);
  vi.mocked(prisma.auditLog.groupBy).mockResolvedValue([]);
});

describe("GET /api/admin/audit-log — extended filters", () => {
  it("supports `page` + `perPage` pagination", async () => {
    await GET(req("page=3&perPage=25"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    // skip = (page - 1) * perPage = 50; take = perPage = 25
    expect(call.skip).toBe(50);
    expect(call.take).toBe(25);
  });

  it("clamps perPage to the allowed set {25, 50, 100}", async () => {
    await GET(req("perPage=999"));
    // any out-of-range value falls back to the default 50
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    expect(call.take).toBe(50);
  });

  it("filters by `actor` against userId OR user.username", async () => {
    await GET(req("actor=marc"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    // Expect an OR clause covering userId + user.username (contains)
    expect(where.OR).toBeDefined();
    const or = where.OR as Array<Record<string, unknown>>;
    const matchesUserId = or.some((c) => c.userId === "marc");
    const matchesUsername = or.some(
      (c) =>
        typeof c.user === "object" &&
        c.user !== null &&
        // user: { username: { contains: "marc", mode: "insensitive" } }
        JSON.stringify(c).toLowerCase().includes("marc"),
    );
    expect(matchesUserId).toBe(true);
    expect(matchesUsername).toBe(true);
  });

  it("filters by `action` exact match", async () => {
    await GET(req("action=auth.login.failed"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    expect(where.action).toBe("auth.login.failed");
  });

  it("filters by `target` (substring on `details` JSON string)", async () => {
    await GET(req("target=measurement-42"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    expect(where.details).toBeDefined();
    expect(JSON.stringify(where.details)).toContain("measurement-42");
  });

  it("filters by `since` and `until` window", async () => {
    const since = "2026-05-01T00:00:00.000Z";
    const until = "2026-05-09T23:59:59.000Z";
    await GET(req(`since=${since}&until=${until}`));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    expect(where.createdAt).toEqual({
      gte: new Date(since),
      lte: new Date(until),
    });
  });

  it("returns paginated meta", async () => {
    vi.mocked(prisma.auditLog.count).mockResolvedValue(123);
    const res = await GET(req("page=2&perPage=25"));
    const json = (await res.json()) as {
      data: { meta: { total: number; page: number; perPage: number } };
    };
    expect(json.data.meta.total).toBe(123);
    expect(json.data.meta.page).toBe(2);
    expect(json.data.meta.perPage).toBe(25);
  });

  it("preserves the legacy `limit`/`offset` shape (back-compat)", async () => {
    await GET(req("limit=10&offset=5"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    expect(call.take).toBe(10);
    expect(call.skip).toBe(5);
  });

  it("supports the legacy `filter=auth` shortcut", async () => {
    await GET(req("filter=auth"));
    const call = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0]!;
    const where = call.where as Record<string, unknown>;
    // startsWith "auth." is the legacy contract
    expect(JSON.stringify(where.action)).toContain("auth.");
  });
});
