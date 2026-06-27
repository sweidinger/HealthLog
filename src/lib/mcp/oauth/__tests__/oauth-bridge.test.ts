/**
 * OAuth bridge — library-level unit tests (artifacts, PKCE, clients, metadata,
 * audience). These pin the security-load-bearing primitives without a DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// A fixed signing key so artifact MACs are deterministic across the run.
process.env.API_TOKEN_HMAC_KEY = "x".repeat(48);
process.env.APP_URL = "https://health.example";

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
  SafeFetchError: class SafeFetchError extends Error {},
}));

import { safeFetch } from "@/lib/safe-fetch";
import { signArtifact, verifyArtifact } from "../artifacts";
import { s256Challenge, verifyPkceS256, isValidVerifier } from "../pkce";
import {
  registerDcrClient,
  resolveClient,
  redirectUriAllowed,
} from "../clients";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
  wwwAuthenticateChallenge,
} from "../metadata";
import { audienceMatches, canonicalResource } from "../config";

describe("artifacts — sign / verify / tamper / expiry / domain separation", () => {
  it("round-trips claims and enforces expiry", () => {
    const token = signArtifact("authCode", { sub: "u1" }, 60_000);
    const ok = verifyArtifact<{ sub: string }>("authCode", token);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.claims.sub).toBe("u1");
  });

  it("rejects an expired artifact", () => {
    const token = signArtifact("authCode", { sub: "u1" }, -1);
    const res = verifyArtifact("authCode", token);
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload (bad signature)", () => {
    const token = signArtifact("authCode", { sub: "u1" }, 60_000);
    // Flip a character in the payload segment.
    const [prefixAndPayload, sig] = [
      token.slice(0, token.lastIndexOf(".")),
      token.slice(token.lastIndexOf(".") + 1),
    ];
    const tampered = `${prefixAndPayload}A.${sig}`;
    const res = verifyArtifact("authCode", tampered);
    expect(res.ok).toBe(false);
  });

  it("domain-separates the three artifact classes", () => {
    const code = signArtifact("authCode", { sub: "u1" }, 60_000);
    // An auth code must not verify as a refresh token or a client id.
    expect(verifyArtifact("refreshToken", code).ok).toBe(false);
    expect(verifyArtifact("clientId", code).ok).toBe(false);
  });
});

describe("PKCE — S256 only", () => {
  it("verifies a correct verifier against its challenge", () => {
    const verifier = "a".repeat(64);
    const challenge = s256Challenge(verifier);
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const challenge = s256Challenge("a".repeat(64));
    expect(verifyPkceS256("b".repeat(64), challenge)).toBe(false);
  });

  it("rejects a too-short verifier (RFC 7636 §4.1)", () => {
    expect(isValidVerifier("short")).toBe(false);
    expect(verifyPkceS256("short", s256Challenge("short"))).toBe(false);
  });
});

describe("clients — DCR (stateless) round-trip", () => {
  it("registers and resolves a DCR client with its redirect URIs", async () => {
    const reg = registerDcrClient({
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    expect(reg.clientId.startsWith("hlc_")).toBe(true);

    const resolved = await resolveClient(reg.clientId);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.client.source).toBe("dcr");
      expect(resolved.client.redirectUris).toEqual([
        "https://claude.ai/api/mcp/auth_callback",
      ]);
    }
  });

  it("rejects an unknown client id", async () => {
    const res = await resolveClient("not-a-client");
    expect(res.ok).toBe(false);
  });
});

describe("clients — CIMD via safeFetch (SSRF-safe)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fetches a CIMD document through safeFetch with requirePublicHost", async () => {
    const clientId = "https://app.example/mcp-client.json";
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: clientId,
          client_name: "ChatGPT",
          redirect_uris: [
            "https://chatgpt.com/connector_platform_oauth_redirect",
          ],
        }),
        { status: 200 },
      ),
    );

    const res = await resolveClient(clientId);
    expect(res.ok).toBe(true);
    // The SSRF guard is requested.
    const opts = vi.mocked(safeFetch).mock.calls[0][2];
    expect(opts?.requirePublicHost).toBe(true);
  });

  it("rejects a CIMD doc whose client_id does not match its URL (SEP-991)", async () => {
    const clientId = "https://app.example/mcp-client.json";
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: "https://attacker.example/other.json",
          redirect_uris: ["https://app.example/cb"],
        }),
        { status: 200 },
      ),
    );
    const res = await resolveClient(clientId);
    expect(res).toEqual({ ok: false, reason: "invalid_metadata" });
  });

  it("surfaces an SSRF block as ssrf_blocked", async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error("private host"));
    const res = await resolveClient("https://169.254.169.254/meta.json");
    expect(res).toEqual({ ok: false, reason: "ssrf_blocked" });
  });

  it("rejects a CIMD doc with a non-https / non-loopback redirect (L2)", async () => {
    const clientId = "https://app.example/mcp-client.json";
    vi.mocked(safeFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          client_id: clientId,
          client_name: "Sketchy",
          redirect_uris: ["http://evil.example/cb"], // non-loopback http
        }),
        { status: 200 },
      ),
    );
    const res = await resolveClient(clientId);
    expect(res).toEqual({ ok: false, reason: "invalid_metadata" });
  });

  it("rejects an oversized CIMD body via the streaming cap (M3)", async () => {
    const clientId = "https://app.example/mcp-client.json";
    // Declared Content-Length over the 16 KB cap → rejected before reading.
    vi.mocked(safeFetch).mockResolvedValue(
      new Response("x".repeat(64), {
        status: 200,
        headers: { "content-length": String(64 * 1024) },
      }),
    );
    const res = await resolveClient(clientId);
    expect(res).toEqual({ ok: false, reason: "invalid_metadata" });
  });
});

describe("clients — redirect URI matching", () => {
  it("matches an exact registered URI (claude.ai callback)", () => {
    const registered = ["https://claude.ai/api/mcp/auth_callback"];
    expect(
      redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", registered),
    ).toBe(true);
  });

  it("matches loopback port-agnostically", () => {
    const registered = ["http://localhost:1234/callback"];
    expect(
      redirectUriAllowed("http://localhost:55999/callback", registered),
    ).toBe(true);
    expect(
      redirectUriAllowed("http://127.0.0.1:1/callback", [
        "http://127.0.0.1:9/callback",
      ]),
    ).toBe(true);
  });

  it("rejects a non-loopback mismatch and a path mismatch", () => {
    expect(
      redirectUriAllowed("https://evil.example/cb", [
        "https://claude.ai/api/mcp/auth_callback",
      ]),
    ).toBe(false);
    expect(
      redirectUriAllowed("http://localhost:1/evil", [
        "http://localhost:2/callback",
      ]),
    ).toBe(false);
  });
});

describe("metadata + audience", () => {
  it("PRM names the canonical /mcp resource", () => {
    const prm = protectedResourceMetadata();
    expect(prm.resource).toBe("https://health.example/mcp");
    expect(prm.authorization_servers).toEqual(["https://health.example"]);
  });

  it("AS metadata advertises S256-only PKCE + CIMD + none auth", () => {
    const as = authorizationServerMetadata();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.grant_types_supported).toContain("authorization_code");
    expect(as.grant_types_supported).toContain("refresh_token");
  });

  it("the WWW-Authenticate challenge points at the PRM", () => {
    expect(wwwAuthenticateChallenge()).toMatch(
      /resource_metadata="https:\/\/health\.example\/\.well-known\/oauth-protected-resource"/,
    );
  });

  it("audience binding accepts the canonical resource and rejects look-alikes", () => {
    expect(audienceMatches(canonicalResource())).toBe(true);
    expect(audienceMatches("https://health.example/mcp/")).toBe(true);
    expect(audienceMatches("https://evil.example/mcp")).toBe(false);
    expect(audienceMatches(undefined)).toBe(false);
  });
});
