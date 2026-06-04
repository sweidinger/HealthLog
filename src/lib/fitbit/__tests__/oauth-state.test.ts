import { describe, expect, it } from "vitest";
import {
  FITBIT_OAUTH_STATE_COOKIE,
  FITBIT_OAUTH_STATE_TTL_MS,
  mintFitbitOAuthStateNonce,
} from "../oauth-state";

describe("Fitbit OAuth state", () => {
  it("pins the cookie name and 10-minute TTL", () => {
    expect(FITBIT_OAUTH_STATE_COOKIE).toBe("fitbit_state");
    expect(FITBIT_OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("mints a 22-char base64url nonce (128 bits, no padding)", () => {
    const nonce = mintFitbitOAuthStateNonce();
    expect(nonce).toHaveLength(22);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("mints unique nonces", () => {
    const set = new Set(
      Array.from({ length: 100 }, () => mintFitbitOAuthStateNonce()),
    );
    expect(set.size).toBe(100);
  });
});
