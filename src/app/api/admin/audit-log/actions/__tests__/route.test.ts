import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
});

describe("GET /api/admin/audit-log/actions", () => {
  it("returns the distinct list of actions sorted ascending", async () => {
    vi.mocked(prisma.auditLog.groupBy).mockResolvedValue([
      { action: "auth.login" },
      { action: "auth.login.failed" },
      { action: "measurement.create" },
    ] as never);
    const res = await (GET as () => Promise<Response>)();
    const json = (await res.json()) as { data: { actions: string[] } };
    expect(json.data.actions).toEqual([
      "auth.login",
      "auth.login.failed",
      "measurement.create",
    ]);
  });
});
