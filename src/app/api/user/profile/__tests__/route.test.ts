import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
});

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeGetReq(): NextRequest {
  return new NextRequest("http://localhost/api/user/profile");
}

describe("GET /api/user/profile", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await callGet(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("returns flattened iOS-style fields", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      username: "marc",
      displayName: "Marc B.",
      email: "marc@example.com",
      dateOfBirth: new Date("1985-03-12T00:00:00.000Z"),
      gender: "MALE",
      heightCm: 180,
      locale: "de",
      timezone: "Europe/Berlin",
    } as never);

    const res = await callGet(makeGetReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        username: string;
        displayName: string | null;
        heightCm: number;
        locale: string | null;
      };
    };
    expect(body.data.username).toBe("marc");
    expect(body.data.displayName).toBe("Marc B.");
    expect(body.data.heightCm).toBe(180);
    expect(body.data.locale).toBe("de");
  });
});

describe("PATCH /api/user/profile", () => {
  function req(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/user/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await PATCH(req({ displayName: "Test" }));
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid heightCm", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await PATCH(req({ heightCm: 9999 }));
    expect(res.status).toBe(422);
  });

  it("persists displayName + locale via shared helper", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({
      id: "user-1",
      username: "marc",
      displayName: "Marc B.",
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: "de",
    } as never);

    const res = await PATCH(req({ displayName: "Marc B.", locale: "de" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user-1" },
        data: expect.objectContaining({
          displayName: "Marc B.",
          locale: "de",
        }),
      }),
    );
  });
});
