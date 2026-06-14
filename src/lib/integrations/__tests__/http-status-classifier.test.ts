import { describe, expect, it } from "vitest";
import {
  classifyHttpStatus,
  classifyIntegrationError,
  IntegrationApiError,
  isOAuthInvalidGrant,
} from "../http-status-classifier";
import { toFailureKind } from "../status";

describe("classifyHttpStatus", () => {
  it("classifies 2xx as success", () => {
    for (const status of [200, 201, 204, 299]) {
      const v = classifyHttpStatus(status);
      expect(v.classification).toBe("success");
      expect(v.httpStatus).toBe(status);
      expect(v.reason).toBe("ok");
    }
  });

  it("classifies 429 as transient (rate-limit)", () => {
    const v = classifyHttpStatus(429);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_429");
  });

  it("classifies 401 and 403 as reauth_required", () => {
    expect(classifyHttpStatus(401).classification).toBe("reauth_required");
    expect(classifyHttpStatus(403).classification).toBe("reauth_required");
    expect(classifyHttpStatus(401).reason).toBe("http_401");
  });

  it("classifies other 4xx as persistent", () => {
    for (const status of [400, 404, 422]) {
      const v = classifyHttpStatus(status);
      expect(v.classification).toBe("persistent");
      expect(v.reason).toBe(`http_${status}`);
    }
  });

  it("classifies 5xx as transient", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyHttpStatus(status).classification).toBe("transient");
    }
  });

  it("classifies an unknown / 3xx status as transient with _unknown reason", () => {
    const v = classifyHttpStatus(302);
    expect(v.classification).toBe("transient");
    expect(v.reason).toBe("http_302_unknown");
  });
});

describe("IntegrationApiError", () => {
  it("carries the vendor label in the message prefix and on the field", () => {
    const err = new IntegrationApiError({
      vendor: "Acme",
      verb: "fetch",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
    });
    expect(err.message).toBe("Acme fetch error: 401");
    expect(err.vendor).toBe("Acme");
    expect(err.classification).toBe("reauth_required");
  });

  it("appends the upstream error segment and caps at 1024 chars", () => {
    const err = new IntegrationApiError({
      vendor: "Acme",
      verb: "token",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_grant",
    });
    expect(err.message).toBe("Acme token error: 400 - invalid_grant");

    const huge = new IntegrationApiError({
      vendor: "Acme",
      verb: "fetch",
      classification: "transient",
      httpStatus: 500,
      reason: "http_500",
      upstreamError: "x".repeat(5000),
    });
    expect(huge.message.length).toBe(1024);
  });
});

describe("isOAuthInvalidGrant", () => {
  it("lifts a 400 invalid_grant from the upstreamError field", () => {
    const err = new IntegrationApiError({
      vendor: "Acme",
      verb: "token",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_grant",
    });
    expect(isOAuthInvalidGrant(err, "Acme")).toBe(true);
  });

  it("does not lift a non-400 or a non-invalid_grant body", () => {
    const wrongStatus = new IntegrationApiError({
      vendor: "Acme",
      verb: "token",
      classification: "reauth_required",
      httpStatus: 401,
      reason: "http_401",
      upstreamError: "invalid_grant",
    });
    expect(isOAuthInvalidGrant(wrongStatus, "Acme")).toBe(false);

    const wrongBody = new IntegrationApiError({
      vendor: "Acme",
      verb: "token",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_client",
    });
    expect(isOAuthInvalidGrant(wrongBody, "Acme")).toBe(false);
  });

  it("falls back to the vendor-scoped message shape across a lost prototype", () => {
    expect(
      isOAuthInvalidGrant(
        new Error("Acme token error: 400 - invalid_grant"),
        "Acme",
      ),
    ).toBe(true);
    // Wrong vendor label in the message → no match.
    expect(
      isOAuthInvalidGrant(
        new Error("Other token error: 400 - invalid_grant"),
        "Acme",
      ),
    ).toBe(false);
  });

  it("returns false for a plain non-API error", () => {
    expect(isOAuthInvalidGrant(new Error("network down"), "Acme")).toBe(false);
    expect(isOAuthInvalidGrant("boom", "Acme")).toBe(false);
  });
});

describe("classifyIntegrationError", () => {
  it("reads the classification off an IntegrationApiError", () => {
    const err = new IntegrationApiError({
      vendor: "Acme",
      verb: "fetch",
      classification: "persistent",
      httpStatus: 404,
      reason: "http_404",
    });
    expect(classifyIntegrationError(err, "Acme")).toBe("persistent");
  });

  it("parses the status out of a legacy vendor-scoped message", () => {
    expect(
      classifyIntegrationError(new Error("Acme fetch error: 503"), "Acme"),
    ).toBe("transient");
    expect(
      classifyIntegrationError(new Error("Acme fetch error: 401"), "Acme"),
    ).toBe("reauth_required");
  });

  it("defaults to transient for an unparseable error", () => {
    expect(classifyIntegrationError(new Error("network down"), "Acme")).toBe(
      "transient",
    );
    expect(classifyIntegrationError("boom", "Acme")).toBe("transient");
  });
});

describe("toFailureKind", () => {
  it("maps reauth_required and persistent through unchanged", () => {
    expect(toFailureKind("reauth_required")).toBe("reauth_required");
    expect(toFailureKind("persistent")).toBe("persistent");
  });

  it("collapses success and transient onto transient", () => {
    expect(toFailureKind("transient")).toBe("transient");
    expect(toFailureKind("success")).toBe("transient");
  });

  it("maps the boundary HTTP codes end-to-end", () => {
    expect(toFailureKind(classifyHttpStatus(401).classification)).toBe(
      "reauth_required",
    );
    expect(toFailureKind(classifyHttpStatus(403).classification)).toBe(
      "reauth_required",
    );
    expect(toFailureKind(classifyHttpStatus(404).classification)).toBe(
      "persistent",
    );
    expect(toFailureKind(classifyHttpStatus(500).classification)).toBe(
      "transient",
    );
    expect(toFailureKind(classifyHttpStatus(429).classification)).toBe(
      "transient",
    );
  });
});
