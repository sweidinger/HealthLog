import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "cookie-user" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { whoopOAuthState: { create: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ setError: vi.fn() }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("@/lib/whoop/client", () => ({
  getAuthorizationUrl: vi.fn(
    (nonce: string) =>
      `https://api.prod.whoop.com/oauth/oauth2/auth?state=${nonce}`,
  ),
}));

vi.mock("@/lib/whoop/credentials", () => ({
  getUserWhoopCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "secret",
  })),
}));

vi.mock("@/lib/whoop/connect-ticket", () => ({
  consumeWhoopConnectTicket: vi.fn(),
}));

vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));

vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number) => ({
    __apiError: true,
    error,
    status,
  }),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/api-handler";
import { consumeWhoopConnectTicket } from "@/lib/whoop/connect-ticket";
import { checkRateLimit } from "@/lib/rate-limit";
import type { NextRequest } from "next/server";

const create = prisma.whoopOAuthState.create as ReturnType<typeof vi.fn>;
const consume = consumeWhoopConnectTicket as unknown as ReturnType<
  typeof vi.fn
>;
const reqAuth = requireAuth as unknown as ReturnType<typeof vi.fn>;

function makeReq(url: string): NextRequest {
  return { url } as NextRequest;
}

describe("GET /api/whoop/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({});
    (checkRateLimit as ReturnType<typeof vi.fn>).mockResolvedValue({
      allowed: true,
    });
  });

  it("cookie path: 302s to WHOOP and stores the state row (no scheme)", async () => {
    const res = await GET(makeReq("https://app.example/api/whoop/connect"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "api.prod.whoop.com/oauth/oauth2/auth",
    );
    expect(reqAuth).toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    const data = create.mock.calls[0][0].data;
    expect(data.userId).toBe("cookie-user");
    expect(data.returnScheme).toBeNull();
    // Nonce cookie is set.
    expect(res.cookies.get("whoop_state")?.value).toBeTruthy();
  });

  it("ticket path: resolves user from the ticket, NOT requireAuth, and 302s to WHOOP", async () => {
    consume.mockResolvedValue({ userId: "ticket-user" });
    const res = await GET(
      makeReq("https://app.example/api/whoop/connect?ticket=opaque123"),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("api.prod.whoop.com");
    expect(consume).toHaveBeenCalledWith("opaque123");
    expect(reqAuth).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.userId).toBe("ticket-user");
  });

  it("ticket path: invalid/expired/used ticket returns typed 401", async () => {
    consume.mockResolvedValue(null);
    const res = (await GET(
      makeReq("https://app.example/api/whoop/connect?ticket=bad"),
    )) as unknown as { __apiError: boolean; status: number };
    expect(res.__apiError).toBe(true);
    expect(res.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("stores a valid return_scheme on the state row", async () => {
    const res = await GET(
      makeReq(
        "https://app.example/api/whoop/connect?return_scheme=dev.healthlog.app",
      ),
    );
    expect(res.status).toBe(307);
    expect(create.mock.calls[0][0].data.returnScheme).toBe("dev.healthlog.app");
  });

  it("rejects http/javascript return_scheme → null (web fallback)", async () => {
    await GET(
      makeReq("https://app.example/api/whoop/connect?return_scheme=http"),
    );
    expect(create.mock.calls[0][0].data.returnScheme).toBeNull();
    create.mockClear();
    await GET(
      makeReq("https://app.example/api/whoop/connect?return_scheme=javascript"),
    );
    expect(create.mock.calls[0][0].data.returnScheme).toBeNull();
  });

  it("ticket + return_scheme combine", async () => {
    consume.mockResolvedValue({ userId: "ticket-user" });
    const res = await GET(
      makeReq(
        "https://app.example/api/whoop/connect?ticket=opaque&return_scheme=dev.healthlog.app",
      ),
    );
    expect(res.status).toBe(307);
    const data = create.mock.calls[0][0].data;
    expect(data.userId).toBe("ticket-user");
    expect(data.returnScheme).toBe("dev.healthlog.app");
  });
});
