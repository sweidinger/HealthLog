import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The document vault's decrypt-and-serve route is framed same-origin by the
 * detail preview (`<iframe>` for inline-class PDFs). The proxy's blanket
 * `X-Frame-Options: DENY` + `frame-ancestors 'none'` would refuse that
 * embed, and the blanket page CSP overrides whatever the route sets
 * (middleware headers win) — so the proxy carves out EXACTLY the
 * `/original` path with a same-origin framing posture and a document CSP
 * (`default-src 'none'`; deliberately no `sandbox` — Chromium
 * force-downloads sandboxed PDFs instead of rendering them).
 *
 * These tests pin both sides of that carve-out: the serve path gets the
 * narrow posture, and every neighbouring documents API path keeps the full
 * DENY posture.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function setNodeEnv(value: "development" | "production") {
  vi.stubEnv("NODE_ENV", value);
}

beforeEach(() => {
  setNodeEnv("production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: "healthlog_session=sess-1" },
  });
}

describe("proxy.ts document serve-route framing carve-out", () => {
  it("allows same-origin framing on the /original serve path", () => {
    const res = proxy(makeRequest("/api/documents/inbound/doc123/original"));
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'none'");
    // No `sandbox` directive: Chromium downloads sandboxed PDFs instead of
    // rendering them, which would break the inline preview outright.
    expect(csp).not.toMatch(/sandbox/);
    // No script sources of any kind for a served document.
    expect(csp).not.toMatch(/script-src/);
  });

  it("keeps the DENY posture on the documents list route", () => {
    const res = proxy(makeRequest("/api/documents/inbound"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy") ?? "").toContain(
      "frame-ancestors 'none'",
    );
  });

  it("keeps the DENY posture on the document detail route", () => {
    const res = proxy(makeRequest("/api/documents/inbound/doc123"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("does not match nested or suffixed lookalike paths", () => {
    for (const path of [
      "/api/documents/inbound/doc123/original/extra",
      "/api/documents/inbound/doc123/originalx",
      "/api/documents/inbound//original",
    ]) {
      const res = proxy(makeRequest(path));
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
  });

  it("keeps the DENY posture on app pages, including /documents itself", () => {
    const res = proxy(makeRequest("/documents"));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy") ?? "").toContain(
      "frame-ancestors 'none'",
    );
  });
});
