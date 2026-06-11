/**
 * Unit tests for the shared shell-cell retry predicate.
 *
 * `useAuth` / `useDashboardSnapshot` used to pin `retry: false`, so one
 * transient blip flipped the shell to the redirect spinner / flashed
 * the full-dashboard empty state. The predicate grants exactly one
 * retry on transport failures and 5xx — never on 4xx, where the server
 * gave a real answer.
 */

import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import { retryOnceOnTransientError } from "../retry-transient";

describe("retryOnceOnTransientError", () => {
  it("retries a network-level failure once", () => {
    const netErr = new TypeError("fetch failed");
    expect(retryOnceOnTransientError(0, netErr)).toBe(true);
    expect(retryOnceOnTransientError(1, netErr)).toBe(false);
  });

  it("retries a timeout abort once", () => {
    const timeoutErr = new DOMException("signal timed out", "TimeoutError");
    expect(retryOnceOnTransientError(0, timeoutErr)).toBe(true);
    expect(retryOnceOnTransientError(1, timeoutErr)).toBe(false);
  });

  it("retries a 5xx once", () => {
    const serverErr = new ApiError("upstream", 503);
    expect(retryOnceOnTransientError(0, serverErr)).toBe(true);
    expect(retryOnceOnTransientError(1, serverErr)).toBe(false);
  });

  it("never retries 401/403 — the server answered", () => {
    expect(retryOnceOnTransientError(0, new ApiError("Unauthorized", 401))).toBe(
      false,
    );
    expect(retryOnceOnTransientError(0, new ApiError("Forbidden", 403))).toBe(
      false,
    );
  });

  it("never retries other 4xx", () => {
    expect(retryOnceOnTransientError(0, new ApiError("Not found", 404))).toBe(
      false,
    );
    expect(retryOnceOnTransientError(0, new ApiError("Too many", 429))).toBe(
      false,
    );
  });
});
