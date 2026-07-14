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
      update: vi.fn(),
    },
    appSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ createSession: vi.fn() }));
vi.mock("@/lib/auth/login-alert", () => ({ recordSignInDevice: vi.fn() }));
vi.mock("@/lib/tz/resolver", () => ({
  resolveServerDefaultTimezone: vi.fn(async () => "Europe/Berlin"),
}));

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
import { auditLog } from "@/lib/auth/audit";
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

/** A minimal user row shaped like what the callback consumes. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "existing@example.com",
    onboardingCompletedAt: new Date(),
    oidcIssuer: null,
    oidcSub: null,
    totpConfirmedAt: null,
    mfaEnforced: false,
    ...overrides,
  };
}

/**
 * The callback's `prisma.user.findFirst` calls are distinguishable by
 * their `where` shape: the (issuer, sub) identity lookup, the display-
 * email collision probe (`NOT`), and the link/provision email match.
 */
function mockUserLookups(opts: {
  byIdentity?: ReturnType<typeof userRow> | null;
  byEmail?: ReturnType<typeof userRow> | null;
  emailTaken?: boolean;
}) {
  vi.mocked(prisma.user.findFirst).mockImplementation(((args: {
    where: Record<string, unknown>;
  }) => {
    if (args.where.oidcIssuer !== undefined) {
      return Promise.resolve(opts.byIdentity ?? null);
    }
    if (args.where.NOT !== undefined) {
      return Promise.resolve(opts.emailTaken ? { id: "user-other" } : null);
    }
    return Promise.resolve(opts.byEmail ?? null);
  }) as never);
}

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

/** A request whose query/state pass the CSRF gate — the default fixture. */
function validRequest(next = "/"): NextRequest {
  return makeRequest({
    query: "?code=abc&state=STATE",
    cookie: stateCookie({
      state: "STATE",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      next,
    }),
  });
}

function mockIdentity(overrides: Record<string, unknown> = {}) {
  vi.mocked(exchangeCodeForTokens).mockResolvedValue({ id_token: "idt" });
  vi.mocked(verifyIdToken).mockResolvedValue({
    sub: "sub-1",
    email: "existing@example.com",
    emailVerified: true,
    name: null,
    ...overrides,
  } as never);
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

  it("redirects with oidc_no_email when the identity has no email at all", async () => {
    mockIdentity({ email: null, emailVerified: undefined });
    mockUserLookups({ byIdentity: null });
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain("error=oidc_no_email");
  });

  it("redirects with oidc_email_unverified when email_verified is absent", async () => {
    // An IdP that never asserts verification cannot anchor a link or a
    // provision — absent is a reject, not a benefit of the doubt.
    mockIdentity({ emailVerified: undefined });
    mockUserLookups({ byIdentity: null, byEmail: null });
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain(
      "error=oidc_email_unverified",
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("redirects with oidc_email_unverified when email_verified is false", async () => {
    mockIdentity({ emailVerified: false });
    mockUserLookups({ byIdentity: null, byEmail: null });
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain(
      "error=oidc_email_unverified",
    );
  });

  it("logs in by (issuer, sub) without consulting the email", async () => {
    // Even with a brand-new email at the IdP, the stamped identity wins —
    // no second account is provisioned and no re-link happens.
    mockIdentity({ email: "renamed@example.com", emailVerified: true });
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
      }),
      emailTaken: false,
    });
    vi.mocked(prisma.user.update).mockResolvedValue(
      userRow({
        email: "renamed@example.com",
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
      }) as never,
    );

    const res = await GET(validRequest("/dashboard"));

    expect(prisma.user.create).not.toHaveBeenCalled();
    // Display email refresh — the only field the update touches.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { email: "renamed@example.com" },
    });
    expect(createSession).toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("skips the display-email refresh when another account holds the address", async () => {
    mockIdentity({ email: "collide@example.com", emailVerified: true });
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
      }),
      emailTaken: true,
    });

    const res = await GET(validRequest());

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalled();
    expect(res.status).toBe(307);
  });

  it("links an existing email-matched account ONCE, stamping (issuer, sub)", async () => {
    mockIdentity();
    mockUserLookups({ byIdentity: null, byEmail: userRow() });
    vi.mocked(prisma.user.update).mockResolvedValue(
      userRow({ oidcIssuer: METADATA.issuer, oidcSub: "sub-1" }) as never,
    );

    const res = await GET(validRequest("/dashboard"));

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { oidcIssuer: METADATA.issuer, oidcSub: "sub-1" },
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.oidc.linked",
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(createSession).toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("rejects a login whose email matches an account bound to a DIFFERENT identity", async () => {
    mockIdentity({ sub: "sub-intruder" });
    mockUserLookups({
      byIdentity: null,
      byEmail: userRow({
        oidcIssuer: "https://other-idp.example.com",
        oidcSub: "sub-original",
      }),
    });

    const res = await GET(validRequest());

    expect(res.headers.get("location")).toContain(
      "error=oidc_identity_conflict",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      "auth.oidc.link_conflict",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("auto-provisions a new user when registration is open", async () => {
    mockIdentity({
      sub: "sub-2",
      email: "New@Example.com",
      emailVerified: true,
    });
    mockUserLookups({ byIdentity: null, byEmail: null });
    vi.mocked(prisma.user.count).mockResolvedValue(3);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: true,
    } as never);
    vi.mocked(prisma.user.create).mockResolvedValue(
      userRow({ id: "user-new", onboardingCompletedAt: null }) as never,
    );

    const res = await GET(validRequest());

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // Lowercased at provision time; stamped with the durable identity
          // and the same server-default timezone the register route resolves.
          email: "new@example.com",
          passwordHash: null,
          role: "USER",
          timezone: "Europe/Berlin",
          oidcIssuer: METADATA.issuer,
          oidcSub: "sub-2",
        }),
      }),
    );
    expect(createSession).toHaveBeenCalled();
    expect(res.status).toBe(307);
  });

  it("refuses to auto-provision when registration is closed", async () => {
    mockIdentity({ sub: "sub-3", email: "blocked@example.com" });
    mockUserLookups({ byIdentity: null, byEmail: null });
    vi.mocked(prisma.user.count).mockResolvedValue(5);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: false,
    } as never);

    const res = await GET(validRequest());

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "error=oidc_registration_disabled",
    );
  });

  it("redirects with oidc_failed when the token exchange throws", async () => {
    vi.mocked(exchangeCodeForTokens).mockRejectedValue(new Error("network"));
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain("error=oidc_failed");
  });
});
