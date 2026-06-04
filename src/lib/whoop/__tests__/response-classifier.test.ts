import { describe, expect, it } from "vitest";
import {
  WhoopApiError,
  classifyWhoopError,
  classifyWhoopResponse,
  isInvalidGrant,
} from "../response-classifier";

describe("classifyWhoopResponse", () => {
  it("classifies 2xx as success", () => {
    for (const status of [200, 201, 204, 299]) {
      const v = classifyWhoopResponse(status);
      expect(v.classification).toBe("success");
      expect(v.httpStatus).toBe(status);
    }
  });

  it("classifies 429 as transient (rate-limit)", () => {
    const v = classifyWhoopResponse(429);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_429");
  });

  it("classifies 401 and 403 as reauth_required", () => {
    expect(classifyWhoopResponse(401).classification).toBe("reauth_required");
    expect(classifyWhoopResponse(403).classification).toBe("reauth_required");
  });

  it("classifies other 4xx as persistent", () => {
    for (const status of [400, 404, 422]) {
      expect(classifyWhoopResponse(status).classification).toBe("persistent");
    }
  });

  it("classifies 5xx as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyWhoopResponse(status).classification).toBe("transient");
    }
  });

  it("defaults unknown / 3xx statuses to transient", () => {
    const v = classifyWhoopResponse(302);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_302_unknown");
  });
});

describe("WhoopApiError", () => {
  it("carries the classification verdict and a bounded message", () => {
    const err = new WhoopApiError({
      verb: "fetchRecoveries",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
    });
    expect(err.classification).toBe("reauth_required");
    expect(err.httpStatus).toBe(401);
    expect(err.name).toBe("WhoopApiError");
    expect(err.message).toContain("WHOOP fetchRecoveries error: 401");
  });

  it("caps a runaway upstream error body at 1024 chars", () => {
    const err = new WhoopApiError({
      verb: "token",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "x".repeat(5000),
    });
    expect(err.message.length).toBeLessThanOrEqual(1024);
  });
});

describe("classifyWhoopError", () => {
  it("reads the verdict from a WhoopApiError directly", () => {
    const err = new WhoopApiError({
      verb: "fetchSleeps",
      classification: "transient",
      httpStatus: 503,
      reason: "http_503",
    });
    expect(classifyWhoopError(err)).toBe("transient");
  });

  it("parses the status out of an unwrapped message", () => {
    const err = new Error("WHOOP fetchCycles error: 403 - forbidden");
    expect(classifyWhoopError(err)).toBe("reauth_required");
  });

  it("falls back to transient for an unrecognised error", () => {
    expect(classifyWhoopError(new Error("network down"))).toBe("transient");
    expect(classifyWhoopError("boom")).toBe("transient");
  });

  it("lifts a 400 invalid_grant from the token endpoint to reauth_required", () => {
    const err = new WhoopApiError({
      verb: "refreshAccessToken",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_grant",
    });
    // The construction-time verdict is persistent (status-only), but the
    // refined classifier promotes the revoked-grant case to reauth.
    expect(err.classification).toBe("persistent");
    expect(classifyWhoopError(err)).toBe("reauth_required");
  });

  it("keeps other 400s persistent (only invalid_grant is reauth)", () => {
    const badClient = new WhoopApiError({
      verb: "refreshAccessToken",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_client",
    });
    expect(classifyWhoopError(badClient)).toBe("persistent");

    const bareBadRequest = new WhoopApiError({
      verb: "fetchRecoveries",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
    });
    expect(classifyWhoopError(bareBadRequest)).toBe("persistent");
  });

  it("detects invalid_grant from a legacy unwrapped message too", () => {
    const err = new Error(
      "WHOOP refreshAccessToken error: 400 - invalid_grant",
    );
    expect(classifyWhoopError(err)).toBe("reauth_required");
  });
});

describe("isInvalidGrant", () => {
  it("is true only for a 400 carrying invalid_grant", () => {
    expect(
      isInvalidGrant(
        new WhoopApiError({
          verb: "refreshAccessToken",
          classification: "persistent",
          httpStatus: 400,
          reason: "http_400",
          upstreamError: "invalid_grant",
        }),
      ),
    ).toBe(true);
  });

  it("is false for invalid_grant on a non-400 status", () => {
    expect(
      isInvalidGrant(
        new WhoopApiError({
          verb: "refreshAccessToken",
          classification: "reauth_required",
          httpStatus: 401,
          reason: "http_401",
          upstreamError: "invalid_grant",
        }),
      ),
    ).toBe(false);
  });

  it("is false for a 400 with a different OAuth error", () => {
    expect(
      isInvalidGrant(
        new WhoopApiError({
          verb: "refreshAccessToken",
          classification: "persistent",
          httpStatus: 400,
          reason: "http_400",
          upstreamError: "invalid_client",
        }),
      ),
    ).toBe(false);
  });

  it("is false for a non-WhoopApiError without the signal", () => {
    expect(isInvalidGrant(new Error("network down"))).toBe(false);
    expect(isInvalidGrant("boom")).toBe(false);
  });
});
