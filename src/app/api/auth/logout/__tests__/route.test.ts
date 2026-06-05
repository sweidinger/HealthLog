import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks must come before importing the route. ---

vi.mock("@/lib/auth/session", () => ({
  destroySession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/refresh-token", () => ({
  revokeBearerAccessToken: vi.fn().mockResolvedValue(true),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

import { POST } from "../route";
import { destroySession } from "@/lib/auth/session";
import { revokeBearerAccessToken } from "@/lib/auth/refresh-token";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(destroySession).mockResolvedValue(undefined);
  vi.mocked(revokeBearerAccessToken).mockResolvedValue(true);
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie session on every request", async () => {
    const res = await POST(makeRequest());
    const body = (await res.json()) as { data: { loggedOut: boolean } };
    expect(res.status).toBe(200);
    expect(body.data.loggedOut).toBe(true);
    expect(destroySession).toHaveBeenCalledTimes(1);
  });

  it("does NOT revoke a bearer when none is presented (cookie path unchanged)", async () => {
    await POST(makeRequest());
    expect(revokeBearerAccessToken).not.toHaveBeenCalled();
  });

  it("revokes the bearer ApiToken + refresh sibling when Authorization: Bearer hlk_ is present", async () => {
    const res = await POST(
      makeRequest({ authorization: "Bearer hlk_abc123def456" }),
    );
    expect(res.status).toBe(200);
    expect(destroySession).toHaveBeenCalledTimes(1);
    expect(revokeBearerAccessToken).toHaveBeenCalledExactlyOnceWith(
      "hlk_abc123def456",
    );
  });

  it("ignores a non-hlk_ bearer value (e.g. a session-style token)", async () => {
    await POST(makeRequest({ authorization: "Bearer not-an-hlk-token" }));
    expect(revokeBearerAccessToken).not.toHaveBeenCalled();
  });
});
