import { describe, expect, it } from "vitest";

import {
  GoogleHealthApiError,
  classifyGoogleHealthError,
  classifyGoogleHealthResponse,
  isGoogleHealthInvalidGrant,
  isGoogleHealthReauthRequired,
} from "../response-classifier";

describe("classifyGoogleHealthResponse", () => {
  it("classifies 2xx as success", () => {
    for (const status of [200, 201, 204, 299]) {
      const v = classifyGoogleHealthResponse(status);
      expect(v.classification).toBe("success");
      expect(v.httpStatus).toBe(status);
    }
  });

  it("classifies 429 as transient (rate-limited — honour Google backoff)", () => {
    const v = classifyGoogleHealthResponse(429);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_429");
  });

  it("classifies 5xx as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyGoogleHealthResponse(status).classification).toBe(
        "transient",
      );
    }
  });

  it("classifies 401 and 403 as reauth_required", () => {
    expect(classifyGoogleHealthResponse(401).classification).toBe(
      "reauth_required",
    );
    expect(classifyGoogleHealthResponse(403).classification).toBe(
      "reauth_required",
    );
  });

  it("classifies other 4xx as persistent (hard reject)", () => {
    for (const status of [400, 404, 422]) {
      expect(classifyGoogleHealthResponse(status).classification).toBe(
        "persistent",
      );
    }
  });
});

describe("classifyGoogleHealthError", () => {
  it("reads the verdict off a typed GoogleHealthApiError", () => {
    const err = new GoogleHealthApiError({
      verb: "fetchWeight",
      classification: "transient",
      httpStatus: 503,
      reason: "http_503",
    });
    expect(classifyGoogleHealthError(err)).toBe("transient");
  });

  it("defaults a plain Error to transient (never hard-disables on an unknown)", () => {
    expect(classifyGoogleHealthError(new Error("socket hang up"))).toBe(
      "transient",
    );
  });

  it("recovers the verdict from the legacy message shape across a lost prototype", () => {
    // A pg-boss retry can strip the prototype; the message-shape fallback still
    // recovers a 401 → reauth_required.
    const plain = new Error("GoogleHealth fetchSleep error: 401");
    expect(classifyGoogleHealthError(plain)).toBe("reauth_required");
  });
});

describe("isGoogleHealthInvalidGrant / isGoogleHealthReauthRequired", () => {
  it("lifts a 400 + invalid_grant onto reauth_required (the 7-day expiry signal)", () => {
    const err = new GoogleHealthApiError({
      verb: "refreshToken",
      classification: "persistent", // a bare 400 classifies persistent…
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_grant",
    });
    expect(isGoogleHealthInvalidGrant(err)).toBe(true);
    // …but the reauth predicate still routes it to the reconnect CTA.
    expect(isGoogleHealthReauthRequired(err)).toBe(true);
  });

  it("keeps a 400 invalid_client as persistent (bad secret ≠ reconnect)", () => {
    const err = new GoogleHealthApiError({
      verb: "refreshToken",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_client",
    });
    expect(isGoogleHealthInvalidGrant(err)).toBe(false);
    expect(isGoogleHealthReauthRequired(err)).toBe(false);
  });

  it("treats a 401 as reauth_required", () => {
    const err = new GoogleHealthApiError({
      verb: "fetchProfile",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
    });
    expect(isGoogleHealthReauthRequired(err)).toBe(true);
  });

  it("does not flag a transient 503 as reauth", () => {
    const err = new GoogleHealthApiError({
      verb: "fetchSteps",
      classification: "transient",
      httpStatus: 503,
      reason: "http_503",
    });
    expect(isGoogleHealthReauthRequired(err)).toBe(false);
  });
});
