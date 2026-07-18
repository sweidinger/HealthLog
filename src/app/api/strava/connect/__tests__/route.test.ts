import { describe, it, expect, vi, beforeEach } from "vitest";

const { rateLimitMock, getCredsMock, mintMock, authUrlMock } = vi.hoisted(
  () => ({
    rateLimitMock: vi.fn(),
    getCredsMock: vi.fn(),
    mintMock: vi.fn(() => "signed-state"),
    authUrlMock: vi.fn(() => "https://www.strava.com/oauth/authorize?x=1"),
  }),
);

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: rateLimitMock }));
vi.mock("@/lib/strava/client", () => ({ getAuthorizationUrl: authUrlMock }));
vi.mock("@/lib/strava/credentials", () => ({
  getStravaClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  OAUTH_STATE_TTL_MS: 600_000,
  mintSignedState: mintMock,
  oauthStateCookieName: () => "strava_oauth_state",
}));

import { GET } from "../route";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

const run = GET as unknown as () => Promise<{
  status: number;
  headers: { get(k: string): string | null };
  cookies: { get(k: string): { value: string } | undefined };
}>;

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({ allowed: true });
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
});

describe("GET /api/strava/connect", () => {
  it("redirects to the consent screen and sets the state cookie", async () => {
    const res = await run();
    expect(res.headers.get("location")).toContain("www.strava.com");
    expect(res.cookies.get("strava_oauth_state")?.value).toBe("signed-state");
  });

  it("redirects to an error when the bucket is exhausted", async () => {
    rateLimitMock.mockResolvedValue({ allowed: false });
    const res = await run();
    expect(res.headers.get("location")).toContain("reason=rate_limited");
    expect(getCredsMock).not.toHaveBeenCalled();
  });

  it("redirects to reason=nocreds when neither BYO nor env credentials resolve", async () => {
    getCredsMock.mockResolvedValue(null);
    const res = await run();
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/settings/integrations");
    expect(location).toContain("strava=error");
    expect(location).toContain("reason=nocreds");
  });
});
