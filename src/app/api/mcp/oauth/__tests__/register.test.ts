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
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(async () => true),
}));

import { POST } from "../register/route";
import { isApiGloballyEnabled } from "@/lib/app-settings";

function jsonReq(body: unknown): Request {
  return new Request("https://health.example/api/mcp/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
});

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

  it("honours a valid OIDC application_type and echoes it back", async () => {
    const res = await POST(
      jsonReq({
        client_name: "Native app",
        application_type: "native",
        redirect_uris: ["http://127.0.0.1:8976/callback"],
      }) as never,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).application_type).toBe("native");
  });

  it("defaults application_type to web when omitted", async () => {
    const res = await POST(
      jsonReq({
        redirect_uris: ["https://chatgpt.com/cb"],
      }) as never,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).application_type).toBe("web");
  });

  it("rejects an invalid application_type with invalid_client_metadata", async () => {
    const res = await POST(
      jsonReq({
        application_type: "robot",
        redirect_uris: ["https://chatgpt.com/cb"],
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client_metadata");
  });

  it("returns 503 when the API is globally disabled (M4)", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(
      jsonReq({ redirect_uris: ["https://chatgpt.com/cb"] }) as never,
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("temporarily_unavailable");
  });
});
