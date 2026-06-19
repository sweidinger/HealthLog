import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { SafeFetchError } from "@/lib/safe-fetch";
import { NightscoutApiError } from "@/lib/nightscout/client";

const { fetchSgvEntriesMock, rateLimitMock } = vi.hoisted(() => ({
  fetchSgvEntriesMock: vi.fn(),
  rateLimitMock: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/integrations/status", () => ({ markReconnected: vi.fn() }));
vi.mock("@/lib/nightscout/client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/nightscout/client")>();
  return { ...actual, fetchSgvEntries: fetchSgvEntriesMock };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: rateLimitMock,
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (error: string, status: number) => ({ data: null, error, status }),
  safeJson: async (req: NextRequest) => {
    try {
      return { data: await req.json(), error: null };
    } catch {
      return { data: null, error: { status: 400 } };
    }
  },
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { markReconnected } from "@/lib/integrations/status";

const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/nightscout/connect", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

type RouteResult = { data: unknown; error: string | null; status: number };
const post = POST as unknown as (r: NextRequest) => Promise<RouteResult>;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, resetAt: 0 });
  fetchSgvEntriesMock.mockResolvedValue([{ id: "x", sgv: 100, date: 1 }]);
});

describe("POST /api/nightscout/connect", () => {
  it("422s on a missing / malformed URL", async () => {
    const res = await post(req({ url: "not a url" }));
    expect(res.status).toBe(422);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("validates via a test fetch and stores encrypted creds on success", async () => {
    const res = await post(
      req({ url: "https://ns.example.com", token: "tok" }),
    );
    expect(res.status).toBe(200);
    expect(fetchSgvEntriesMock).toHaveBeenCalledTimes(1);
    const fetchArg = fetchSgvEntriesMock.mock.calls[0]![0];
    expect(fetchArg.count).toBe(1);
    expect(fetchArg.allowPrivateHost).toBe(false);

    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.nightscoutUrlEncrypted).toBe("enc:https://ns.example.com");
    expect(data.nightscoutTokenEncrypted).toBe("enc:tok");
    expect(data.nightscoutAllowPrivateHost).toBe(false);
    expect(markReconnected).toHaveBeenCalledWith("u1", "nightscout");
  });

  it("stores a null token for a public, token-less instance", async () => {
    await post(req({ url: "https://ns.example.com" }));
    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.nightscoutTokenEncrypted).toBeNull();
  });

  it("passes the private-host opt-in through to the test fetch", async () => {
    await post(
      req({
        url: "http://192.168.1.5:1337",
        token: "tok",
        allowPrivateHost: true,
      }),
    );
    const fetchArg = fetchSgvEntriesMock.mock.calls[0]![0];
    expect(fetchArg.allowPrivateHost).toBe(true);
  });

  it("refuses a private host when the opt-in is off (clear 422, no store)", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new SafeFetchError("refused", "private_host"),
    );
    const res = await post(req({ url: "http://10.0.0.5", token: "tok" }));
    expect(res.status).toBe(422);
    expect(String(res.error)).toMatch(/private network/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a wrong-token rejection as a clear 422", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new NightscoutApiError("responded 401", 401),
    );
    const res = await post(req({ url: "https://ns.example.com", token: "x" }));
    expect(res.status).toBe(422);
    expect(String(res.error)).toMatch(/token/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("surfaces an unreachable instance as a clear 422", async () => {
    fetchSgvEntriesMock.mockRejectedValue(
      new SafeFetchError("timeout", "timeout"),
    );
    const res = await post(req({ url: "https://ns.example.com" }));
    expect(res.status).toBe(422);
    expect(String(res.error)).toMatch(/reach/i);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("rate-limits the connect surface", async () => {
    rateLimitMock.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: 0,
    });
    const res = await post(req({ url: "https://ns.example.com" }));
    expect(res.status).toBe(429);
    expect(fetchSgvEntriesMock).not.toHaveBeenCalled();
  });
});
