import { describe, expect, it } from "vitest";
import {
  WHOOP_OAUTH_STATE_COOKIE,
  WHOOP_OAUTH_STATE_TTL_MS,
  mintWhoopOAuthStateNonce,
} from "../oauth-state";

describe("WHOOP OAuth state", () => {
  it("pins the cookie name and 10-minute TTL", () => {
    expect(WHOOP_OAUTH_STATE_COOKIE).toBe("whoop_state");
    expect(WHOOP_OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("mints a 22-char base64url nonce (128 bits, no padding)", () => {
    const nonce = mintWhoopOAuthStateNonce();
    expect(nonce).toHaveLength(22);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("mints unique nonces", () => {
    const set = new Set(
      Array.from({ length: 100 }, () => mintWhoopOAuthStateNonce()),
    );
    expect(set.size).toBe(100);
  });
});
