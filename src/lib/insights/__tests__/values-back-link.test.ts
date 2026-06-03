import { describe, it, expect } from "vitest";

import { resolveValuesBackHref } from "../values-back-link";

/**
 * v1.10.2 — the `/insights/values/[type]` back-link returns to the originating
 * metric page via a sanitised `from` param. The guard keeps the target an
 * internal `/insights/<slug>` path so a crafted value can never redirect
 * off-site.
 */
describe("resolveValuesBackHref", () => {
  it("returns the originating metric page when from is an internal insights path", () => {
    expect(resolveValuesBackHref("/insights/weight")).toBe("/insights/weight");
    expect(resolveValuesBackHref("/insights/blood-pressure")).toBe(
      "/insights/blood-pressure",
    );
  });

  it("falls back to the overview when from is missing", () => {
    expect(resolveValuesBackHref(null)).toBe("/insights");
    expect(resolveValuesBackHref(undefined)).toBe("/insights");
    expect(resolveValuesBackHref("")).toBe("/insights");
  });

  it("rejects the overview itself and any non-metric path", () => {
    expect(resolveValuesBackHref("/insights")).toBe("/insights");
    expect(resolveValuesBackHref("/settings/account")).toBe("/insights");
  });

  it("rejects off-site and protocol-relative targets", () => {
    expect(resolveValuesBackHref("https://evil.example/insights/weight")).toBe(
      "/insights",
    );
    expect(resolveValuesBackHref("//evil.example")).toBe("/insights");
    expect(resolveValuesBackHref("/insights//evil.example")).toBe("/insights");
  });
});
