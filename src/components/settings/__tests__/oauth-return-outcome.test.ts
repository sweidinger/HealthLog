/**
 * v1.17.1 (04-M1) — the WHOOP / Fitbit OAuth callbacks redirect back with
 * `?whoop=connected|error` / `?fitbit=connected|error&reason=<tag>`, but the
 * settings page only read the param for Withings/Polar/Oura — so a user
 * returning from a WHOOP or Fitbit round-trip landed on a silently unchanged
 * page. These pin the four-provider outcome parsing + reason-key resolution.
 */
import { describe, it, expect } from "vitest";

import { parseOAuthOutcome, oauthReasonKey } from "../integrations-section";

describe("parseOAuthOutcome", () => {
  it("reads a connected outcome for every OAuth provider", () => {
    for (const p of ["polar", "oura", "whoop", "fitbit", "strava"] as const) {
      expect(parseOAuthOutcome(`?${p}=connected`)).toEqual({
        provider: p,
        kind: "connected",
      });
    }
  });

  it("reads WHOOP + Fitbit error outcomes with their reason tag (the gap fix)", () => {
    expect(parseOAuthOutcome("?whoop=error&reason=token")).toEqual({
      provider: "whoop",
      kind: "error",
      reason: "token",
    });
    expect(parseOAuthOutcome("?strava=error&reason=cross_user")).toEqual({
      provider: "strava",
      kind: "error",
      reason: "cross_user",
    });
    expect(parseOAuthOutcome("?fitbit=error&reason=expired")).toEqual({
      provider: "fitbit",
      kind: "error",
      reason: "expired",
    });
  });

  it("defaults a missing reason to 'unknown'", () => {
    expect(parseOAuthOutcome("?whoop=error")).toEqual({
      provider: "whoop",
      kind: "error",
      reason: "unknown",
    });
  });

  it("returns null when no provider param is present", () => {
    expect(parseOAuthOutcome("?foo=bar")).toBeNull();
    expect(parseOAuthOutcome("")).toBeNull();
  });
});

describe("oauthReasonKey", () => {
  it("maps a known tag to the provider-specific key", () => {
    expect(oauthReasonKey("whoop", "token")).toBe(
      "settings.whoopOauthError.token",
    );
    expect(oauthReasonKey("fitbit", "expired")).toBe(
      "settings.fitbitOauthError.expired",
    );
  });

  it("falls back to generic for an unknown tag", () => {
    expect(oauthReasonKey("whoop", "totally_unknown")).toBe(
      "settings.whoopOauthError.generic",
    );
  });
});
