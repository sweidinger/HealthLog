import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/passkey", () => ({
  createAuthenticationOptions: vi.fn().mockResolvedValue({
    options: {},
    challengeId: "ch-1",
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 9,
    reset: 0,
    ip: "203.0.113.1",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import { POST } from "../route";
import { createAuthenticationOptions } from "@/lib/auth/passkey";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";

const OIDC_ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_ONLY",
] as const;
const original: Record<string, string | undefined> = {};

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/auth/passkey/login-options", {
    method: "POST",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of OIDC_ENV_KEYS) original[key] = process.env[key];
  vi.mocked(createAuthenticationOptions).mockResolvedValue({
    options: {},
    challengeId: "ch-1",
  } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    reset: 0,
    ip: "203.0.113.1",
  } as never);
});

afterEach(() => {
  for (const key of OIDC_ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("POST /api/auth/passkey/login-options — OIDC_ONLY server-side enforcement", () => {
  it("rejects before minting a WebAuthn challenge when OIDC_ONLY is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(createAuthenticationOptions).not.toHaveBeenCalled();
  });

  it("still allows passkey login-options when OIDC_ONLY is set but the provider is half-configured", async () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});
