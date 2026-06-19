import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Demo-mode mutation allowlist. On a `DEMO_MODE=true` deploy the proxy
 * 403s every non-GET `/api/*` request except a narrow allowlist. Login
 * is the historical baseline; the two dashboard display-pref writes
 * (chart-overlay toggles + comparison-baseline selector) were added so
 * the above-chart toggles work in the demo. They touch nothing but the
 * caller's own `User.dashboardWidgetsJson` blob.
 *
 * This guard locks the allowlist shape in place so a refactor can't
 * silently widen it (admitting a data-bearing mutation) or narrow it
 * (re-breaking the demo toggles). The whole block is gated on
 * `DEMO_MODE === "true"`, so production is unaffected by construction —
 * the final case proves the gate.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function makeRequest(pathname: string, method: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, { method });
}

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

describe("proxy.ts DEMO_MODE mutation allowlist", () => {
  beforeEach(() => {
    process.env.DEMO_MODE = "true";
  });

  afterEach(() => {
    if (ORIGINAL_DEMO_MODE === undefined) {
      delete process.env.DEMO_MODE;
    } else {
      process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
    }
  });

  it("permits the chart-overlay-prefs PUT (above-chart display toggles)", () => {
    const res = proxy(makeRequest("/api/dashboard/chart-overlay-prefs", "PUT"));
    expect(res.status).not.toBe(403);
  });

  it("permits the dashboard-widgets PUT (comparison-baseline selector)", () => {
    const res = proxy(makeRequest("/api/dashboard/widgets", "PUT"));
    expect(res.status).not.toBe(403);
  });

  it("still blocks a health-data mutation (POST /api/measurements)", () => {
    const res = proxy(makeRequest("/api/measurements", "POST"));
    expect(res.status).toBe(403);
  });

  it("does not drag in the layout-reset DELETE on the allowlisted widgets path", () => {
    // The allowlist pins method per path; admitting the widgets PUT
    // must not open DELETE (which wipes the user's dashboard layout).
    const res = proxy(makeRequest("/api/dashboard/widgets", "DELETE"));
    expect(res.status).toBe(403);
  });

  it("is inert when DEMO_MODE is off — production is unaffected", () => {
    delete process.env.DEMO_MODE;
    // With the demo gate off, the proxy never short-circuits an API
    // mutation; the route's own auth/handler runs instead.
    const res = proxy(makeRequest("/api/measurements", "POST"));
    expect(res.status).not.toBe(403);
  });
});
