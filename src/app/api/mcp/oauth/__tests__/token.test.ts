/**
 * Token endpoint — PKCE verification, audience binding, single-use codes,
 * refresh-token rotation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.API_TOKEN_HMAC_KEY = "x".repeat(48);
process.env.APP_URL = "https://health.example";

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(async () => ({
    token: "hlk_" + "a".repeat(64),
    expiresAt: new Date(Date.now() + 3_600_000),
    tokenId: "tok-1",
    name: "MCP connector",
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 100,
    resetAt: Date.now() + 60_000,
    ip: "1.2.3.4",
  })),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 0,
    resetAt: Date.now() + 60_000,
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import { randomUUID } from "node:crypto";
import { POST } from "../token/route";
import { issueApiToken } from "@/lib/auth/issue-token";
import { checkRateLimit } from "@/lib/rate-limit";
import { signArtifact } from "@/lib/mcp/oauth/artifacts";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";

const CLIENT_ID = "https://app.example/client.json";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const CHALLENGE = s256Challenge(VERIFIER);
const RESOURCE = "https://health.example/mcp";

function authCode(overrides: Record<string, unknown> = {}): string {
  return signArtifact(
    "authCode",
    {
      jti: randomUUID(),
      sub: "user-1",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      scope: "health:read offline_access",
      resource: RESOURCE,
      ...overrides,
    },
    120_000,
  );
}

function tokenReq(fields: Record<string, string>): Request {
  return new Request("https://health.example/api/mcp/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 0,
    resetAt: Date.now() + 60_000,
  });
});

describe("authorization_code grant", () => {
  it("exchanges a valid code + verifier for an access token (+ refresh)", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^hlk_/);
    expect(body.refresh_token).toMatch(/^hlrt_/);
    expect(body.scope).toContain("health:read");
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ["health:read"] }),
    );
  });

  it("rejects a wrong PKCE verifier with invalid_grant", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: "b".repeat(64),
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("rejects a code bound to a different audience", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode({ resource: "https://evil.example/mcp" }),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_target");
  });

  it("rejects a code presented by a different client", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: "https://other.example/client.json",
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a replayed code (single-use jti already claimed)", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(issueApiToken).not.toHaveBeenCalled();
  });
});

describe("refresh_token grant", () => {
  it("rotates: issues a new access + refresh pair", async () => {
    const refresh = signArtifact(
      "refreshToken",
      {
        jti: randomUUID(),
        sub: "user-1",
        client_id: CLIENT_ID,
        scope: "health:read offline_access",
        resource: RESOURCE,
      },
      1_000_000,
    );
    const res = await POST(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: CLIENT_ID,
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^hlk_/);
    expect(body.refresh_token).toMatch(/^hlrt_/);
  });
});

describe("grant validation", () => {
  it("rejects an unsupported grant_type", async () => {
    const res = await POST(tokenReq({ grant_type: "password" }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});
