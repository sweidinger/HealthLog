import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ setError: vi.fn() }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    appSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ createSession: vi.fn() }));
vi.mock("@/lib/auth/login-alert", () => ({ recordSignInDevice: vi.fn() }));

vi.mock("@/lib/auth/oidc", () => ({
  getOidcConfig: vi.fn(),
  discoverOidcMetadata: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  verifyIdToken: vi.fn(),
  fetchUserinfoEmail: vi.fn(),
  getOidcRedirectUri: () =>
    "https://healthlog.example.com/api/auth/oidc/callback",
  deriveUniqueUsername: vi.fn(async (email: string) => email.split("@")[0]),
}));

import { GET } from "../route";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import {
  getOidcConfig,
  discoverOidcMetadata,
  exchangeCodeForTokens,
  verifyIdToken,
} from "@/lib/auth/oidc";

const CONFIG = {
  issuerUrl: "https://idp.example.com",
  clientId: "client-1",
  clientSecret: "secret-1",
  scopes: "openid email profile",
  buttonLabel: "SSO",
};
const METADATA = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
};

function makeRequest(opts: { query?: string; cookie?: string }): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/auth/oidc/callback${opts.query ?? ""}`,
  );
  if (opts.cookie) {
    req.cookies.set("oidc_auth_state", opts.cookie);
  }
  return req;
}

function stateCookie(payload: Record<string, unknown>): string {
  return `enc(${JSON.stringify(payload)})`;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 20,
    reset: 0,
    ip: "1.2.3.4",
  } as never);
  vi.mocked(getOidcConfig).mockReturnValue(CONFIG);
  vi.mocked(discoverOidcMetadata).mockResolvedValue(METADATA);
});

describe("GET /api/auth/oidc/callback", () => {
  it("redirects with oidc_denied when the IdP reports an error", async () => {
    const res = await GET(makeRequest({ query: "?error=access_denied" }));
    expect(res.headers.get("location")).toContain("error=oidc_denied");
  });

  it("redirects with oidc_state when code/state are missing", async () => {
    const res = await GET(makeRequest({}));
    expect(res.headers.get("location")).toContain("error=oidc_state");
  });

  it("redirects with oidc_state when the state cookie is missing", async () => {
    const res = await GET(makeRequest({ query: "?code=abc&state=xyz" }));
    expect(res.headers.get("location")).toContain("error=oidc_state");
  });

  it("redirects with oidc_state on a state/cookie mismatch (CSRF)", async () => {
    const res = await GET(
      makeRequest({
        query: "?code=abc&state=WRONG",
        cookie: stateCookie({
          state: "RIGHT",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/",
        }),
      }),
    );
    expect(res.headers.get("location")).toContain("error=oidc_state");
  });

  it("redirects with oidc_no_email when the identity has no verified email", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({ id_token: "idt" });
    vi.mocked(verifyIdToken).mockResolvedValue({
      sub: "sub-1",
      email: null,
      emailVerified: undefined,
      name: null,
    });
    const res = await GET(
      makeRequest({
        query: "?code=abc&state=STATE",
        cookie: stateCookie({
          state: "STATE",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/",
        }),
      }),
    );
    expect(res.headers.get("location")).toContain("error=oidc_no_email");
  });

  it("logs in an existing user matched by email without provisioning", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({ id_token: "idt" });
    vi.mocked(verifyIdToken).mockResolvedValue({
      sub: "sub-1",
      email: "existing@example.com",
      emailVerified: true,
      name: "Existing",
    });
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-1",
      onboardingCompletedAt: new Date(),
    } as never);

    const res = await GET(
      makeRequest({
        query: "?code=abc&state=STATE",
        cookie: stateCookie({
          state: "STATE",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/dashboard",
        }),
      }),
    );

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      "user-1",
      false,
      "1.2.3.4",
      null,
      expect.any(Date),
    );
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("auto-provisions a new user when registration is open", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({ id_token: "idt" });
    vi.mocked(verifyIdToken).mockResolvedValue({
      sub: "sub-2",
      email: "new@example.com",
      emailVerified: true,
      name: "New",
    });
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockResolvedValue(3);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: true,
    } as never);
    vi.mocked(prisma.user.create).mockResolvedValue({
      id: "user-new",
      onboardingCompletedAt: null,
    } as never);

    const res = await GET(
      makeRequest({
        query: "?code=abc&state=STATE",
        cookie: stateCookie({
          state: "STATE",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/",
        }),
      }),
    );

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "new@example.com",
          passwordHash: null,
          role: "USER",
        }),
      }),
    );
    expect(createSession).toHaveBeenCalled();
    expect(res.status).toBe(307);
  });

  it("refuses to auto-provision when registration is closed", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValue({ id_token: "idt" });
    vi.mocked(verifyIdToken).mockResolvedValue({
      sub: "sub-3",
      email: "blocked@example.com",
      emailVerified: true,
      name: null,
    });
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.user.count).mockResolvedValue(5);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: false,
    } as never);

    const res = await GET(
      makeRequest({
        query: "?code=abc&state=STATE",
        cookie: stateCookie({
          state: "STATE",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/",
        }),
      }),
    );

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "error=oidc_registration_disabled",
    );
  });

  it("redirects with oidc_failed when the token exchange throws", async () => {
    vi.mocked(exchangeCodeForTokens).mockRejectedValue(new Error("network"));
    const res = await GET(
      makeRequest({
        query: "?code=abc&state=STATE",
        cookie: stateCookie({
          state: "STATE",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/",
        }),
      }),
    );
    expect(res.headers.get("location")).toContain("error=oidc_failed");
  });
});
