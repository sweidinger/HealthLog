import { describe, it, expect } from "vitest";
import { generatePKCE, generateState, buildAuthorizationUrl } from "../codex-oauth";

describe("codex-oauth", () => {
  describe("generatePKCE", () => {
    it("generates verifier and challenge of correct format", () => {
      const { verifier, challenge } = generatePKCE();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(challenge.length).toBeGreaterThanOrEqual(43);
      expect(verifier).not.toContain("=");
      expect(challenge).not.toContain("=");
      expect(verifier).not.toContain("+");
      expect(challenge).not.toContain("+");
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

  describe("buildAuthorizationUrl", () => {
    it("builds correct URL with all params", () => {
      const url = buildAuthorizationUrl({
        codeChallenge: "test-challenge",
        state: "test-state",
        redirectUri: "https://example.com/callback",
      });

      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://chatgpt.com");
      expect(parsed.pathname).toBe("/authorize");
      expect(parsed.searchParams.get("response_type")).toBe("code");
      expect(parsed.searchParams.get("code_challenge")).toBe("test-challenge");
      expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
      expect(parsed.searchParams.get("state")).toBe("test-state");
      expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/callback");
    });
  });
});
