/**
 * Gating predicate for app-wide service-worker registration.
 *
 * The registrar must install `/sw.js` only in production and only where the
 * browser supports the API. Dev lacks the generated `/sw-version.js` (the
 * `prebuild` step writes it) and a caching SW fights HMR, so a dev register
 * would be actively harmful.
 */
import { describe, expect, it } from "vitest";

import { shouldRegisterServiceWorker } from "../service-worker-registrar";

describe("shouldRegisterServiceWorker", () => {
  it("registers in production with window + serviceWorker support", () => {
    expect(shouldRegisterServiceWorker("production", true, true)).toBe(true);
  });

  it("does not register outside production", () => {
    expect(shouldRegisterServiceWorker("development", true, true)).toBe(false);
    expect(shouldRegisterServiceWorker("test", true, true)).toBe(false);
    expect(shouldRegisterServiceWorker(undefined, true, true)).toBe(false);
  });

  it("does not register without a window (SSR)", () => {
    expect(shouldRegisterServiceWorker("production", false, true)).toBe(false);
  });

  it("does not register when serviceWorker is unsupported", () => {
    expect(shouldRegisterServiceWorker("production", true, false)).toBe(false);
  });
});
