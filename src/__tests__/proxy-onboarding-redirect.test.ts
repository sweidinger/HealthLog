import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.22 C4 — onboarding redirect moved from `<AuthShell>` useEffect
 * to `src/proxy.ts` so it lands on the first server response instead
 * of post-hydration. The previous client-side approach caused a brief
 * dashboard flash for users with `onboardingCompletedAt === null`.
 *
 * The proxy reads the `hl_onboarding` cookie (which the auth routes
 * mirror from the DB `onboardingCompletedAt` column) without a DB
 * roundtrip — Edge runtime can't reach Prisma. The cookie is a UX
 * hint, not a security signal: a user editing it locally only skips
 * the dashboard flash, they still can't bypass any server check.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function makeRequest(
  pathname: string,
  cookies: Record<string, string> = {},
): NextRequest {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://localhost${pathname}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

describe("proxy.ts onboarding redirect (v1.4.22 C4)", () => {
  it("307s a session with hl_onboarding=pending from / to /onboarding", () => {
    const res = proxy(
      makeRequest("/", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    // NextResponse.redirect returns a 307 by default in Next 16.
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/onboarding$/);
  });

  it("307s a pending session from /insights to /onboarding", () => {
    const res = proxy(
      makeRequest("/insights", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/onboarding$/);
  });

  it("does NOT redirect from /onboarding itself", () => {
    const res = proxy(
      makeRequest("/onboarding", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    // /onboarding is in PUBLIC_PATHS so the proxy passes through; the
    // response is a NextResponse.next() with security headers applied.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does NOT redirect from /auth/login", () => {
    const res = proxy(
      makeRequest("/auth/login", { hl_onboarding: "pending" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes through when hl_onboarding cookie is absent (completed users)", () => {
    const res = proxy(makeRequest("/", { healthlog_session: "sess-1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes through API routes even when onboarding is pending", () => {
    // API routes do their own getSession() checks — the proxy must
    // never redirect them or every legitimate /api/* call would 307.
    const res = proxy(
      makeRequest("/api/measurements", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects unauthenticated users to /auth/login (existing contract)", () => {
    const res = proxy(makeRequest("/"));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/auth\/login$/);
  });
});
