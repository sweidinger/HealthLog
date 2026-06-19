import { describe, expect, it } from "vitest";
import {
  FitbitApiError,
  classifyFitbitError,
  classifyFitbitResponse,
} from "../response-classifier";

describe("classifyFitbitResponse", () => {
  it("classifies 2xx as success", () => {
    for (const status of [200, 201, 204, 299]) {
      const v = classifyFitbitResponse(status);
      expect(v.classification).toBe("success");
      expect(v.httpStatus).toBe(status);
    }
  });

  it("classifies 429 as transient (rate-limit)", () => {
    const v = classifyFitbitResponse(429);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_429");
  });

  it("classifies 401 and 403 as reauth_required", () => {
    expect(classifyFitbitResponse(401).classification).toBe("reauth_required");
    expect(classifyFitbitResponse(403).classification).toBe("reauth_required");
  });

  it("classifies other 4xx as persistent", () => {
    for (const status of [400, 404, 422]) {
      expect(classifyFitbitResponse(status).classification).toBe("persistent");
    }
  });

  it("classifies 5xx as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyFitbitResponse(status).classification).toBe("transient");
    }
  });

  it("defaults an unrecognised status to transient", () => {
    expect(classifyFitbitResponse(308).classification).toBe("transient");
  });
});

describe("FitbitApiError", () => {
  it("carries the verdict and caps the message at 1024 chars", () => {
    const err = new FitbitApiError({
      verb: "exchangeCode",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
      upstreamError: "invalid_grant",
    });
    expect(err.name).toBe("FitbitApiError");
    expect(err.classification).toBe("reauth_required");
    expect(err.httpStatus).toBe(401);
    expect(err.upstreamError).toBe("invalid_grant");
    expect(err.message).toContain("invalid_grant");
    expect(err.message.length).toBeLessThanOrEqual(1024);
  });
});

describe("classifyFitbitError", () => {
  it("reads the classification off a FitbitApiError", () => {
    const err = new FitbitApiError({
      verb: "refreshAccessToken",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
    });
    expect(classifyFitbitError(err)).toBe("persistent");
  });

  it("parses the status out of a legacy message shape", () => {
    expect(
      classifyFitbitError(new Error("Fitbit fetchProfile error: 401")),
    ).toBe("reauth_required");
    expect(classifyFitbitError(new Error("Fitbit sync error: 500"))).toBe(
      "transient",
    );
  });

  it("defaults a non-Fitbit error to transient", () => {
    expect(classifyFitbitError(new Error("network down"))).toBe("transient");
    expect(classifyFitbitError("boom")).toBe("transient");
  });

  it("treats a 401 on the token endpoint as reauth (no invalid_grant special-case)", () => {
    // Google signals a revoked grant with a 401 status, not a 400 invalid_grant
    // body — the status-driven classifier already buckets it as reauth.
    const err = new FitbitApiError({
      verb: "refreshAccessToken",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
      upstreamError: "invalid_grant",
    });
    expect(classifyFitbitError(err)).toBe("reauth_required");
  });
});
