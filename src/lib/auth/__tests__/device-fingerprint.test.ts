import { describe, it, expect } from "vitest";
import {
  coarseDeviceLabel,
  normaliseUserAgent,
  coarseLocationSignal,
  computeDeviceHash,
  maskIp,
} from "../device-fingerprint";

const FIREFOX_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0";
const FIREFOX_MAC_MINOR =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

describe("coarseDeviceLabel", () => {
  it("reduces a UA to family + platform", () => {
    expect(coarseDeviceLabel(FIREFOX_MAC)).toBe("Firefox on macOS");
    expect(coarseDeviceLabel(CHROME_WIN)).toBe("Chrome on Windows");
  });
  it("handles a missing UA", () => {
    expect(coarseDeviceLabel(null)).toBe("Unknown device");
    expect(coarseDeviceLabel("")).toBe("Unknown device");
  });
});

describe("coarseLocationSignal", () => {
  it("reduces a city string to its country token", () => {
    expect(coarseLocationSignal("Berlin, DE")).toBe("DE");
  });
  it("returns empty for no location", () => {
    expect(coarseLocationSignal(null)).toBe("");
  });
});

describe("computeDeviceHash", () => {
  it("is deterministic and a hex SHA-256 (no raw UA/IP leak)", () => {
    const h = computeDeviceHash({
      userId: "u1",
      userAgent: FIREFOX_MAC,
      coarseSignal: "DE",
    });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // The hash must not embed the raw UA.
    expect(h).not.toContain("Firefox");
    expect(h).not.toContain("Mozilla");
    expect(
      computeDeviceHash({
        userId: "u1",
        userAgent: FIREFOX_MAC,
        coarseSignal: "DE",
      }),
    ).toBe(h);
  });

  it("is invariant to a minor browser-version bump (no false new-device)", () => {
    const a = computeDeviceHash({
      userId: "u1",
      userAgent: FIREFOX_MAC,
      coarseSignal: "DE",
    });
    const b = computeDeviceHash({
      userId: "u1",
      userAgent: FIREFOX_MAC_MINOR,
      coarseSignal: "DE",
    });
    expect(a).toBe(b);
  });

  it("is salted per user — same browser, different account ⇒ different hash", () => {
    const a = computeDeviceHash({
      userId: "u1",
      userAgent: FIREFOX_MAC,
      coarseSignal: "DE",
    });
    const b = computeDeviceHash({
      userId: "u2",
      userAgent: FIREFOX_MAC,
      coarseSignal: "DE",
    });
    expect(a).not.toBe(b);
  });

  it("treats a different country as a new device", () => {
    const a = computeDeviceHash({
      userId: "u1",
      userAgent: FIREFOX_MAC,
      coarseSignal: "DE",
    });
    const b = computeDeviceHash({
      userId: "u1",
      userAgent: FIREFOX_MAC,
      coarseSignal: "US",
    });
    expect(a).not.toBe(b);
  });
});

describe("normaliseUserAgent", () => {
  it("matches the coarse label so the hash input is stable", () => {
    expect(normaliseUserAgent(FIREFOX_MAC)).toBe("Firefox on macOS");
  });
});

describe("maskIp", () => {
  it("masks the host portion of an IPv4", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.x.x");
  });
  it("masks an IPv6 down to two hextets", () => {
    expect(maskIp("2001:db8:1234:5678::1")).toBe("2001:db8::");
  });
  it("returns null for a blank IP", () => {
    expect(maskIp(null)).toBeNull();
    expect(maskIp("")).toBeNull();
  });
});
