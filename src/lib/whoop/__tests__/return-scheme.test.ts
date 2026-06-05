import { describe, expect, it } from "vitest";
import {
  buildReturnSchemeRedirect,
  validateReturnScheme,
} from "../return-scheme";

describe("validateReturnScheme", () => {
  it("accepts the allowlisted native scheme (case-insensitive)", () => {
    expect(validateReturnScheme("dev.healthlog.app")).toBe("dev.healthlog.app");
    expect(validateReturnScheme("DEV.HealthLog.App")).toBe("dev.healthlog.app");
  });

  it("returns null for absent / empty input", () => {
    expect(validateReturnScheme(null)).toBeNull();
    expect(validateReturnScheme(undefined)).toBeNull();
    expect(validateReturnScheme("")).toBeNull();
  });

  it("rejects forbidden web/script schemes even if shaped like a scheme", () => {
    for (const s of ["http", "https", "javascript", "data", "file", "vbscript"]) {
      expect(validateReturnScheme(s)).toBeNull();
    }
  });

  it("rejects a syntactically valid but non-allowlisted custom scheme", () => {
    expect(validateReturnScheme("com.evil.app")).toBeNull();
    expect(validateReturnScheme("myapp")).toBeNull();
  });

  it("rejects malformed schemes (bad first char, spaces, slashes)", () => {
    expect(validateReturnScheme("1app")).toBeNull();
    expect(validateReturnScheme("dev healthlog")).toBeNull();
    expect(validateReturnScheme("dev/healthlog")).toBeNull();
    expect(validateReturnScheme("dev:healthlog")).toBeNull();
    expect(validateReturnScheme("dev.healthlog.app://whoop")).toBeNull();
  });

  it("rejects an over-long value", () => {
    expect(validateReturnScheme("a".repeat(65))).toBeNull();
  });
});

describe("buildReturnSchemeRedirect", () => {
  it("builds the connected target", () => {
    expect(buildReturnSchemeRedirect("dev.healthlog.app", "connected")).toBe(
      "dev.healthlog.app://whoop?whoop=connected",
    );
  });

  it("builds the error target with an encoded reason", () => {
    expect(
      buildReturnSchemeRedirect("dev.healthlog.app", "error", "expired"),
    ).toBe("dev.healthlog.app://whoop?whoop=error&reason=expired");
  });

  it("defaults a missing reason to 'unknown'", () => {
    expect(buildReturnSchemeRedirect("dev.healthlog.app", "error")).toBe(
      "dev.healthlog.app://whoop?whoop=error&reason=unknown",
    );
  });
});
