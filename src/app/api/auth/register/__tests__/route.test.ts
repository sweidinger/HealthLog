/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/auth/register.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn().mockResolvedValue({ registrationEnabled: true }),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn().mockResolvedValue("hashed"),
  checkPasswordStrength: vi
    .fn()
    .mockReturnValue({ isAcceptable: true, feedback: [] }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn().mockResolvedValue("en"),
}));

vi.mock("@/lib/tz/resolver", () => ({
  isValidTimezone: vi.fn().mockReturnValue(true),
  resolveServerDefaultTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { checkRateLimit, checkAuthSurfaceRateLimit } from "@/lib/rate-limit";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "1.2.3.4",
  } as never);
});

describe("POST /api/auth/register — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad email + too-short username.
    const res = await postPathThrough({ email: "not-an-email", username: "x" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // Bad email + bad username + bad password.
    const res = await postPathThrough({
      email: "not-an-email",
      username: "x",
      password: "weak",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

async function postPathThrough(body: unknown): Promise<Response> {
  return POST(postReq(body));
}

describe("POST /api/auth/register — OIDC_ONLY server-side enforcement", () => {
  const OIDC_ENV_KEYS = [
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_ONLY",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of OIDC_ENV_KEYS) original[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("rejects self-registration before any DB lookup when OIDC_ONLY is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await postPathThrough({
      email: "new@example.com",
      username: "newuser",
      password: "a-very-strong-password-123",
    });
    expect(res.status).toBe(403);
  });

  it("still allows registration when OIDC_ONLY is set but the provider is half-configured", async () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await postPathThrough({ email: "not-an-email", username: "x" });
    // Falls through to normal validation (422 here) rather than 403 — a
    // half-set OIDC group must never lock everyone out.
    expect(res.status).toBe(422);
  });
});
