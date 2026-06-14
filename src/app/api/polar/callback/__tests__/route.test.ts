import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  stateMatchesCookieMock,
  verifySignedStateMock,
  getSessionMock,
  exchangeCodeMock,
  registerUserMock,
  getCredsMock,
  markReconnectedMock,
} = vi.hoisted(() => ({
  stateMatchesCookieMock: vi.fn(),
  verifySignedStateMock: vi.fn(),
  getSessionMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  registerUserMock: vi.fn(),
  getCredsMock: vi.fn(),
  markReconnectedMock: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/db", () => ({ prisma: { user: { update: vi.fn() } } }));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ setAuth: vi.fn(), setError: vi.fn() }),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/auth/session", () => ({ getSession: getSessionMock }));
vi.mock("@/lib/polar/client", () => ({
  exchangeCode: exchangeCodeMock,
  registerUser: registerUserMock,
}));
vi.mock("@/lib/polar/credentials", () => ({
  getPolarClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  oauthStateCookieName: () => "polar_oauth_state",
  stateMatchesCookie: stateMatchesCookieMock,
  verifySignedState: verifySignedStateMock,
}));
vi.mock("@/lib/integrations/status", () => ({
  markReconnected: markReconnectedMock,
}));

import { GET } from "../route";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function makeReq(): Parameters<typeof GET>[0] {
  return {
    url: "https://app.example/api/polar/callback?code=abc&state=s",
    cookies: { get: () => ({ value: "s" }) },
  } as unknown as Parameters<typeof GET>[0];
}

const run = GET as unknown as (req: ReturnType<typeof makeReq>) => Promise<{
  status: number;
  headers: { get(k: string): string | null };
}>;

beforeEach(() => {
  vi.clearAllMocks();
  stateMatchesCookieMock.mockReturnValue(true);
  verifySignedStateMock.mockReturnValue({ userId: "u1" });
  getSessionMock.mockResolvedValue(null);
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
  exchangeCodeMock.mockResolvedValue({ access_token: "tok", x_user_id: 42 });
  registerUserMock.mockResolvedValue(undefined);
});

describe("GET /api/polar/callback", () => {
  it("completes the handshake and redirects to connected", async () => {
    const res = await run(makeReq());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("polar=connected");
    expect(markReconnectedMock).toHaveBeenCalledWith("u1", "polar");
  });

  it("rejects a CSRF cookie/param mismatch before exchanging the code", async () => {
    stateMatchesCookieMock.mockReturnValue(false);
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=csrf1");
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-user session completing another user's handshake", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "other" } });
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=cross_user");
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("rejects an off-spec token body missing x_user_id", async () => {
    exchangeCodeMock.mockResolvedValue({ access_token: "tok" });
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=token");
    expect(registerUserMock).not.toHaveBeenCalled();
  });
});
