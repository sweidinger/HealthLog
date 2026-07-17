import { describe, it, expect } from "vitest";
import { sanitizeSameOriginPath } from "../url-safety";

const BASE = "https://healthlog.example.com/auth/login";

describe("sanitizeSameOriginPath", () => {
  it("passes through a plain same-origin path", () => {
    expect(sanitizeSameOriginPath("/dashboard", BASE)).toBe("/dashboard");
  });

  it("defaults to / when next is null, undefined, or empty", () => {
    expect(sanitizeSameOriginPath(null, BASE)).toBe("/");
    expect(sanitizeSameOriginPath(undefined, BASE)).toBe("/");
    expect(sanitizeSameOriginPath("", BASE)).toBe("/");
  });

  it("rejects a protocol-relative next (//host)", () => {
    expect(sanitizeSameOriginPath("//evil.com", BASE)).toBe("/");
  });

  it("rejects an absolute next pointing at another origin", () => {
    expect(sanitizeSameOriginPath("https://evil.com/phish", BASE)).toBe("/");
  });

  it("rejects the backslash-normalization bypass (/\\evil.com)", () => {
    // WHATWG URL parsing treats a leading backslash as a path separator for
    // special schemes, so a naive startsWith("/") && !startsWith("//")
    // check would accept this — Next.js's router.push() re-parses the
    // string the same way and hard-navigates to the resolved origin.
    expect(sanitizeSameOriginPath("/\\evil.com", BASE)).toBe("/");
    expect(sanitizeSameOriginPath("\\\\evil.com", BASE)).toBe("/");
  });

  it("rejects a same-origin next whose pathname collapses to protocol-relative", () => {
    // `/..//evil.com` resolves ON-origin here (the `..` collapses at root),
    // but its pathname is `//evil.com`. Consumers re-resolve the returned
    // value (`new URL(result, base)`, `router.push`), where `//evil.com`
    // becomes protocol-relative and escapes to https://evil.com. The
    // reconstructed-path re-check must reject these to "/".
    expect(sanitizeSameOriginPath("/..//evil.com", BASE)).toBe("/");
    expect(sanitizeSameOriginPath("/.//evil.com", BASE)).toBe("/");
    expect(sanitizeSameOriginPath("/../..//evil.com", BASE)).toBe("/");
  });

  it("still allows a legitimate same-origin path with an inner double slash", () => {
    // Only a LEADING `//` (protocol-relative) escapes on re-resolve; a double
    // slash inside the path stays on-origin and must be preserved.
    expect(sanitizeSameOriginPath("/reports/a//b", BASE)).toBe("/reports/a//b");
  });

  it("preserves a same-origin path's search and hash", () => {
    expect(sanitizeSameOriginPath("/settings?tab=security#top", BASE)).toBe(
      "/settings?tab=security#top",
    );
  });

  it("falls back to / on an unparseable value", () => {
    expect(sanitizeSameOriginPath("https://", BASE)).toBe("/");
  });
});
