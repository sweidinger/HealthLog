import { describe, expect, it } from "vitest";

import {
  isAllowlistedApiRead,
  isCacheableApiResponse,
} from "@/lib/pwa/sw-cache-policy";

describe("isAllowlistedApiRead — offline read boundary", () => {
  it("caches the curated safe GET read endpoints", () => {
    expect(isAllowlistedApiRead("/api/dashboard/snapshot")).toBe(true);
    expect(isAllowlistedApiRead("/api/dashboard/widgets")).toBe(true);
    expect(isAllowlistedApiRead("/api/measurements")).toBe(true);
    expect(
      isAllowlistedApiRead("/api/measurements/series-batch?types=WEIGHT"),
    ).toBe(true);
    expect(isAllowlistedApiRead("/api/medications")).toBe(true);
    expect(isAllowlistedApiRead("/api/insights")).toBe(true);
    expect(isAllowlistedApiRead("/api/analytics")).toBe(true);
    expect(isAllowlistedApiRead("/api/version")).toBe(true);
  });

  it("never caches auth / session / token / login surfaces", () => {
    expect(isAllowlistedApiRead("/api/auth/me")).toBe(false);
    expect(isAllowlistedApiRead("/api/auth/logout")).toBe(false);
    expect(isAllowlistedApiRead("/api/sessions")).toBe(false);
    expect(isAllowlistedApiRead("/api/tokens")).toBe(false);
    expect(isAllowlistedApiRead("/api/login")).toBe(false);
    expect(isAllowlistedApiRead("/api/webauthn/options")).toBe(false);
  });

  it("refuses an auth/token segment nested under an allowlisted prefix", () => {
    expect(isAllowlistedApiRead("/api/medications/tokens")).toBe(false);
    expect(isAllowlistedApiRead("/api/insights/auth")).toBe(false);
  });

  it("does not cache endpoints outside the allowlist", () => {
    expect(isAllowlistedApiRead("/api/admin/users")).toBe(false);
    expect(isAllowlistedApiRead("/api/devices")).toBe(false);
    expect(isAllowlistedApiRead("/api/withings/callback")).toBe(false);
  });

  it("does not match a prefix that is only a partial path segment", () => {
    // `/api/measurements-export` must NOT match `/api/measurements`.
    expect(isAllowlistedApiRead("/api/measurements-export")).toBe(false);
  });
});

describe("isCacheableApiResponse — body/header refusal", () => {
  it("caches a successful read with a plain body", () => {
    expect(
      isCacheableApiResponse({
        ok: true,
        cacheControl: "private, max-age=0",
        bodyText: JSON.stringify({ data: { weightKg: 80 }, error: null }),
      }),
    ).toBe(true);
  });

  it("refuses non-ok responses", () => {
    expect(isCacheableApiResponse({ ok: false, bodyText: "{}" })).toBe(false);
  });

  it("refuses a no-store response", () => {
    expect(
      isCacheableApiResponse({
        ok: true,
        cacheControl: "no-store",
        bodyText: "{}",
      }),
    ).toBe(false);
  });

  it("refuses secret-shaped bodies (hlk_ / hlr_ / sk-)", () => {
    expect(
      isCacheableApiResponse({
        ok: true,
        bodyText: JSON.stringify({ data: { token: "hlk_abc123def" } }),
      }),
    ).toBe(false);
    expect(
      isCacheableApiResponse({
        ok: true,
        bodyText: JSON.stringify({ data: { refresh: "hlr_xyz789ghi" } }),
      }),
    ).toBe(false);
    expect(
      isCacheableApiResponse({
        ok: true,
        bodyText: JSON.stringify({ data: { key: "sk-livesecret00" } }),
      }),
    ).toBe(false);
  });
});
