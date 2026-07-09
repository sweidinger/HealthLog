import { describe, it, expect } from "vitest";

import { getNumberFormat, getDateTimeFormat } from "../formatter-cache";

describe("formatter-cache", () => {
  it("returns the same NumberFormat instance for identical (locale, options)", () => {
    const a = getNumberFormat("en", { maximumFractionDigits: 2 });
    const b = getNumberFormat("en", { maximumFractionDigits: 2 });
    expect(a).toBe(b);
  });

  it("returns distinct NumberFormat instances for different options", () => {
    const a = getNumberFormat("en", { maximumFractionDigits: 2 });
    const b = getNumberFormat("en", { maximumFractionDigits: 0 });
    expect(a).not.toBe(b);
  });

  it("returns distinct instances per locale", () => {
    const a = getNumberFormat("en", { maximumFractionDigits: 1 });
    const b = getNumberFormat("de", { maximumFractionDigits: 1 });
    expect(a).not.toBe(b);
  });

  it("caches DateTimeFormat and still formats correctly", () => {
    const a = getDateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const b = getDateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    expect(a).toBe(b);
    expect(a.format(new Date("2026-05-08T12:00:00Z"))).toBe("2026-05-08");
  });
});
