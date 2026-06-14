import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OAUTH_STATE_TTL_MS,
  mintSignedState,
  oauthStateCookieName,
  stateMatchesCookie,
  verifySignedState,
} from "../signed-state";

const KEY = "x".repeat(48);

describe("OAuth signed state (Polar / Oura)", () => {
  let prevKey: string | undefined;

  beforeEach(() => {
    prevKey = process.env.API_TOKEN_HMAC_KEY;
    process.env.API_TOKEN_HMAC_KEY = KEY;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.API_TOKEN_HMAC_KEY;
    else process.env.API_TOKEN_HMAC_KEY = prevKey;
  });

  it("pins the cookie name per provider", () => {
    expect(oauthStateCookieName("polar")).toBe("polar_oauth_state");
    expect(oauthStateCookieName("oura")).toBe("oura_oauth_state");
  });

  it("round-trips a minted token back to the userId + provider", () => {
    const now = 1_000_000;
    const token = mintSignedState("polar", "user-abc", now);
    const verified = verifySignedState("polar", token, now + 1000);
    expect(verified).toEqual({
      provider: "polar",
      userId: "user-abc",
      expiry: now + OAUTH_STATE_TTL_MS,
    });
  });

  it("mints unique tokens for the same user (nonce entropy)", () => {
    const a = mintSignedState("oura", "u1");
    const b = mintSignedState("oura", "u1");
    expect(a).not.toBe(b);
  });

  it("rejects a token whose provider does not match", () => {
    const token = mintSignedState("polar", "u1");
    expect(verifySignedState("oura", token)).toBeNull();
  });

  it("rejects a tampered userId (signature mismatch)", () => {
    const now = 5_000;
    const token = mintSignedState("polar", "victim", now);
    const parts = token.split(".");
    parts[1] = "attacker";
    const forged = parts.join(".");
    expect(verifySignedState("polar", forged, now + 1)).toBeNull();
  });

  it("rejects a tampered signature tag", () => {
    const token = mintSignedState("oura", "u1");
    const forged = token.slice(0, -3) + "AAA";
    expect(verifySignedState("oura", forged)).toBeNull();
  });

  it("rejects an expired token even with a valid signature", () => {
    const now = 10_000;
    const token = mintSignedState("polar", "u1", now);
    expect(verifySignedState("polar", token, now + OAUTH_STATE_TTL_MS + 1)).toBeNull();
  });

  it("rejects malformed shapes and empty input", () => {
    expect(verifySignedState("polar", null)).toBeNull();
    expect(verifySignedState("polar", "")).toBeNull();
    expect(verifySignedState("polar", "a.b.c")).toBeNull();
    expect(verifySignedState("polar", "polar.u1.notanumber.nonce.tag")).toBeNull();
  });

  it("a token minted under a different key fails verification", () => {
    const token = mintSignedState("polar", "u1");
    process.env.API_TOKEN_HMAC_KEY = "y".repeat(48);
    expect(verifySignedState("polar", token)).toBeNull();
  });

  it("double-submit compare is byte-exact", () => {
    const token = mintSignedState("oura", "u1");
    expect(stateMatchesCookie(token, token)).toBe(true);
    expect(stateMatchesCookie(token, token + "x")).toBe(false);
    expect(stateMatchesCookie(token, null)).toBe(false);
    expect(stateMatchesCookie(null, token)).toBe(false);
  });
});
