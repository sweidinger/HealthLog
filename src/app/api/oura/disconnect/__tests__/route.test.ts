import { describe, it, expect, vi, beforeEach } from "vitest";

const { rateLimitMock } = vi.hoisted(() => ({ rateLimitMock: vi.fn() }));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({ markDisconnected: vi.fn() }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: rateLimitMock,
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (error: string, status: number) => ({ data: null, error, status }),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;

type RouteResult = { data: unknown; error: string | null; status: number };
const post = POST as unknown as () => Promise<RouteResult>;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({ allowed: true, remaining: 19, resetAt: 0 });
  userFind.mockResolvedValue({ ouraAccessTokenEncrypted: "enc:tok" });
});

describe("POST /api/oura/disconnect", () => {
  it("disconnects a connected user", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ disconnected: true });
  });

  it("rate-limits the disconnect surface (429 on bucket exhaustion)", async () => {
    rateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: 0,
    });
    const res = await post();
    expect(res.status).toBe(429);
    // The user lookup never runs once the bucket is exhausted.
    expect(userFind).not.toHaveBeenCalled();
  });
});
