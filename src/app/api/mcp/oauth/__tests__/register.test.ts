/**
 * DCR registration (RFC 7591) — stateless `hlc_` client-id issuance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.API_TOKEN_HMAC_KEY = "x".repeat(48);

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 19,
    resetAt: Date.now() + 60_000,
    ip: "1.2.3.4",
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));

import { POST } from "../register/route";

function jsonReq(body: unknown): Request {
  return new Request("https://health.example/api/mcp/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /register", () => {
  it("registers a public client and returns an hlc_ client_id", async () => {
    const res = await POST(
      jsonReq({
        client_name: "ChatGPT",
        redirect_uris: [
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
      }) as never,
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^hlc_/);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.redirect_uris).toEqual([
      "https://chatgpt.com/connector_platform_oauth_redirect",
    ]);
  });

  it("accepts a loopback redirect (Claude Code)", async () => {
    const res = await POST(
      jsonReq({ redirect_uris: ["http://127.0.0.1:8976/callback"] }) as never,
    );
    expect(res.status).toBe(201);
  });

  it("rejects a missing redirect_uris with invalid_client_metadata", async () => {
    const res = await POST(jsonReq({ client_name: "x" }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });

  it("rejects a non-https, non-loopback redirect_uri", async () => {
    const res = await POST(
      jsonReq({ redirect_uris: ["http://evil.example/cb"] }) as never,
    );
    expect(res.status).toBe(400);
  });
});
