import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.17.0 — `/invite/<hlv_token>` is the invite universal-link landing
 * (iOS #16). It is a thin shape-validated redirect onto
 * `/auth/register?invite=…` and carries no session, so an unauthenticated
 * visitor (scanning the admin QR) must reach it without the auth-gate
 * bounce to `/auth/login`. This guard locks the allowlist entry in place
 * so a future refactor of `src/proxy.ts` cannot silently re-gate it.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

const VALID_TOKEN = `hlv_${"a".repeat(64)}`;

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

describe("proxy.ts /invite public-allowlist (v1.17.0)", () => {
  it("does not 307 an unauthenticated /invite/<token> to /auth/login", () => {
    const res = proxy(makeRequest(`/invite/${VALID_TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("admits a pending-onboarding session onto the invite landing", () => {
    const res = proxy(
      makeRequest(`/invite/${VALID_TOKEN}`, {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects unauthenticated requests for protected pages", () => {
    // Negative check — confirms the fixture would catch a real
    // regression. `/insights` is not public.
    const res = proxy(makeRequest("/insights"));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/auth\/login/);
  });
});
