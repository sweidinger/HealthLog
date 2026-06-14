import { describe, expect, it } from "vitest";

import {
  PolarApiError,
  classifyPolarError,
  isInvalidGrant,
} from "../response-classifier";

describe("classifyPolarError — invalid_grant reauth lift (H-1)", () => {
  it("lifts a 400 invalid_grant on the token endpoint to reauth_required", () => {
    const err = new PolarApiError({
      verb: "exchangeCode",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_grant",
    });
    expect(isInvalidGrant(err)).toBe(true);
    expect(classifyPolarError(err)).toBe("reauth_required");
  });

  it("recovers the verdict from the message shape after a lost prototype", () => {
    // A pg-boss retry can strip the PolarApiError prototype; the message-shape
    // fallback must still recognise the invalid_grant signal.
    const bare = new Error("Polar exchangeCode error: 400 - invalid_grant");
    expect(isInvalidGrant(bare)).toBe(true);
    expect(classifyPolarError(bare)).toBe("reauth_required");
  });

  it("leaves a non-invalid_grant 400 as persistent", () => {
    const err = new PolarApiError({
      verb: "exchangeCode",
      classification: "persistent",
      httpStatus: 400,
      reason: "http_400",
      upstreamError: "invalid_client",
    });
    expect(isInvalidGrant(err)).toBe(false);
    expect(classifyPolarError(err)).toBe("persistent");
  });

  it("keeps a 401 reauth and a 500 transient classification", () => {
    expect(
      classifyPolarError(
        new PolarApiError({
          verb: "fetchSleeps",
          classification: "reauth_required",
          httpStatus: 401,
          reason: "http_401",
        }),
      ),
    ).toBe("reauth_required");
    expect(
      classifyPolarError(
        new PolarApiError({
          verb: "fetchSleeps",
          classification: "transient",
          httpStatus: 500,
          reason: "http_500",
        }),
      ),
    ).toBe("transient");
  });
});
