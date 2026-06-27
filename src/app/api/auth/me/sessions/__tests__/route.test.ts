import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { session: { findMany: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
  destroyOtherSessions: vi.fn(),
  destroySessionById: vi.fn(),
}));

vi.mock("@/lib/geo", () => ({
  lookupIpLocation: vi.fn(async () => "Berlin, DE"),
}));

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

import { GET, DELETE } from "../route";
import { DELETE as DELETE_ONE } from "../[id]/route";
import { prisma } from "@/lib/db";
import {
  getSession,
  destroyOtherSessions,
  destroySessionById,
} from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-current", expiresAt: new Date(Date.now() + 3.6e6) },
  user: { id: "user-1", username: "u", role: "USER" as const },
};

function del(): NextRequest {
  return new NextRequest("http://localhost/api/auth/me/sessions", {
    method: "DELETE",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/auth/me/sessions", () => {
  it("401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists sessions with masked IP, location, and the current marker", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.session.findMany).mockResolvedValue([
      {
        id: "sess-current",
        ipAddress: "203.0.113.7",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0",
        lastActiveAt: new Date(),
        createdAt: new Date(),
      },
      {
        id: "sess-other",
        ipAddress: "198.51.100.4",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0) Chrome/119.0.0.0 Safari/537.36",
        lastActiveAt: null,
        createdAt: new Date(),
      },
    ] as never);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const list = body.data.sessions;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      id: "sess-current",
      device: "Firefox on macOS",
      ipMasked: "203.0.x.x",
      location: "Berlin, DE",
      isCurrent: true,
    });
    expect(list[1].isCurrent).toBe(false);
    // The full IP never appears in the response body.
    expect(JSON.stringify(body)).not.toContain("203.0.113.7");
  });
});

describe("DELETE /api/auth/me/sessions (sign out everywhere)", () => {
  it("revokes other sessions and reports the count", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(destroyOtherSessions).mockResolvedValue({ sessionsRevoked: 3 });

    const res = await DELETE(del());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sessionsRevoked).toBe(3);
    expect(destroyOtherSessions).toHaveBeenCalledWith("user-1", "sess-current");
  });
});

describe("DELETE /api/auth/me/sessions/[id]", () => {
  function ctx(id: string) {
    return { params: Promise.resolve({ id }) };
  }
  function delReq(id: string): NextRequest {
    return new NextRequest(`http://localhost/api/auth/me/sessions/${id}`, {
      method: "DELETE",
    });
  }

  it("revokes a single owned session", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(destroySessionById).mockResolvedValue(true);
    const res = await DELETE_ONE(delReq("sess-other"), ctx("sess-other"));
    expect(res.status).toBe(200);
    expect(destroySessionById).toHaveBeenCalledWith("user-1", "sess-other");
  });

  it("404 for a non-existent or not-owned id", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(destroySessionById).mockResolvedValue(false);
    const res = await DELETE_ONE(delReq("nope"), ctx("nope"));
    expect(res.status).toBe(404);
  });
});
