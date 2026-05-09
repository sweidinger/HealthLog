import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, "")),
}));

import {
  generatePKCE,
  generateState,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshTokens,
  obtainApiKey,
  encryptCodexCreds,
  decryptCodexCreds,
  getCodexClientId,
} from "../codex-oauth";

describe("codex-oauth", () => {
  describe("generatePKCE", () => {
    it("generates verifier and challenge of correct format", () => {
      const { verifier, challenge } = generatePKCE();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(challenge.length).toBeGreaterThanOrEqual(43);
      expect(verifier).not.toContain("=");
      expect(challenge).not.toContain("=");
    });

    it("generates different values each time", () => {
      const a = generatePKCE();
      const b = generatePKCE();
      expect(a.verifier).not.toBe(b.verifier);
    });
  });

  describe("generateState", () => {
    it("generates a non-empty base64url string", () => {
      const state = generateState();
      expect(state.length).toBeGreaterThan(20);
      expect(state).not.toContain("=");
    });
  });

  describe("getCodexClientId", () => {
    const ORIGINAL = process.env.CODEX_OAUTH_CLIENT_ID;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.CODEX_OAUTH_CLIENT_ID;
      else process.env.CODEX_OAUTH_CLIENT_ID = ORIGINAL;
    });

    it("falls back to the public Codex CLI client ID when env is unset", () => {
      delete process.env.CODEX_OAUTH_CLIENT_ID;
      expect(getCodexClientId()).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    });

    it("respects an operator override", () => {
      process.env.CODEX_OAUTH_CLIENT_ID = "app_private_test";
      expect(getCodexClientId()).toBe("app_private_test");
    });
  });

  describe("buildAuthorizationUrl", () => {
    it("targets auth.openai.com with the codex CLI scope set", () => {
      const url = buildAuthorizationUrl({
        codeChallenge: "test-challenge",
        state: "test-state",
        redirectUri: "https://example.com/callback",
      });

      const parsed = new URL(url);
      // The previous v1.4.6 pointed at chatgpt.com, which is not an
      // OAuth issuer at all. Anchoring this assertion explicitly so a
      // future regression to the wrong host fails loudly.
      expect(parsed.origin).toBe("https://auth.openai.com");
      expect(parsed.pathname).toBe("/oauth/authorize");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("client_id")).toBe(
        "app_EMoamEEZ73f0CkXaXp7hrann",
      );
      expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsed.searchParams.get("state")).toBe("test-state");
      expect(parsed.searchParams.get("redirect_uri")).toBe(
        "https://example.com/callback",
      );
      expect(parsed.searchParams.get("scope")).toContain("offline_access");
      expect(parsed.searchParams.get("id_token_add_organizations")).toBe(
        "true",
      );
      expect(parsed.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    });
  });

  describe("token / api-key exchange", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it("exchanges the auth code for tokens and trades the id_token for an api key", async () => {
      const calls: Array<{ url: string; body: string }> = [];
      global.fetch = vi.fn(
        async (url: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(url), body: String(init?.body ?? "") });
          if (calls.length === 1) {
            // Token endpoint — returns id_token + access_token + refresh_token.
            return new Response(
              JSON.stringify({
                id_token: "id-token-abc",
                access_token: "oauth-access",
                refresh_token: "oauth-refresh",
                expires_in: 3600,
                token_type: "Bearer",
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          // Api-key exchange.
          return new Response(
            JSON.stringify({ access_token: "sk-from-codex" }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      ) as never;

      const result = await exchangeCodeForTokens({
        code: "auth-code",
        codeVerifier: "verifier",
        redirectUri: "https://example.com/cb",
      });

      expect(result.apiKey).toBe("sk-from-codex");
      expect(result.refreshToken).toBe("oauth-refresh");
      expect(result.expiresAt).toBeInstanceOf(Date);

      // Both calls hit auth.openai.com with form-urlencoded bodies.
      expect(calls[0].url).toBe("https://auth.openai.com/oauth/token");
      expect(calls[0].body).toContain("grant_type=authorization_code");
      expect(calls[0].body).toContain("code_verifier=verifier");
      expect(calls[1].url).toBe("https://auth.openai.com/oauth/token");
      expect(calls[1].body).toContain(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange",
      );
      expect(calls[1].body).toContain("subject_token=id-token-abc");
      expect(calls[1].body).toContain("requested_token=openai-api-key");
    });

    it("refreshTokens re-uses the refresh token and re-runs api-key exchange", async () => {
      let call = 0;
      global.fetch = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              id_token: "id-fresh",
              access_token: "oauth-access-fresh",
              refresh_token: "oauth-refresh-fresh",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ access_token: "sk-rotated" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never;

      const result = await refreshTokens("old-refresh");
      expect(result.apiKey).toBe("sk-rotated");
      expect(result.refreshToken).toBe("oauth-refresh-fresh");
    });

    it("obtainApiKey throws when the upstream omits access_token", async () => {
      global.fetch = vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ) as never;
      await expect(obtainApiKey("id-token-x")).rejects.toThrow(
        /no access_token/i,
      );
    });
  });

  describe("encryptCodexCreds / decryptCodexCreds", () => {
    it("round-trips api key and refresh token", () => {
      const enc = encryptCodexCreds({
        apiKey: "sk-test",
        refreshToken: "refresh-test",
      });
      expect(enc.apiKeyEncrypted).toBe("enc:sk-test");
      expect(enc.refreshEncrypted).toBe("enc:refresh-test");

      const dec = decryptCodexCreds({
        apiKeyEncrypted: enc.apiKeyEncrypted,
        refreshEncrypted: enc.refreshEncrypted,
      });
      expect(dec.apiKey).toBe("sk-test");
      expect(dec.refreshToken).toBe("refresh-test");
    });
  });
});
