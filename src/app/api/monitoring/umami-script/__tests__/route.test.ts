/**
 * Fail-soft contract for the Umami proxy route: an unreachable / refused
 * upstream degrades to the noop script (200, never a 500) AND stays
 * observable — the catch annotates a proper wide-event action
 * (`monitoring.umami_script.fetch_failed`) with a truncated reason so
 * dashboards can see the degraded state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/monitoring-settings", () => ({
  getPublicMonitoringSettings: vi.fn(),
}));

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: vi.fn(),
}));

import { GET } from "../route";
import { annotate } from "@/lib/logging/context";
import { getPublicMonitoringSettings } from "@/lib/monitoring-settings";
import { safeFetch } from "@/lib/safe-fetch";

const callGet = GET as unknown as () => Promise<Response>;

const ENABLED_SETTINGS = {
  umamiEnabled: true,
  umamiScriptUrl: "https://stats.example.com/script.js",
  umamiWebsiteId: "site-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPublicMonitoringSettings).mockResolvedValue(
    ENABLED_SETTINGS as never,
  );
});

describe("GET /api/monitoring/umami-script — fail-soft observability", () => {
  it("serves the noop script (200) and annotates the failure action when the upstream fetch throws", async () => {
    vi.mocked(safeFetch).mockRejectedValue(
      new Error("connect ETIMEDOUT 192.0.2.10:443"),
    );

    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("umami disabled");

    // The fail-soft must stay observable: a proper
    // `<surface>.<noun>.<verb>` action + a truncated reason, not a bare
    // meta flag.
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "monitoring.umami_script.fetch_failed" },
      meta: { reason: "connect ETIMEDOUT 192.0.2.10:443" },
    });
  });

  it("truncates an oversized error message in the reason meta", async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error("x".repeat(500)));

    const res = await callGet();
    expect(res.status).toBe(200);

    const failureCall = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          call[0]?.action?.name === "monitoring.umami_script.fetch_failed",
      );
    expect(failureCall).toBeTruthy();
    expect(
      (failureCall?.[0]?.meta as { reason: string }).reason,
    ).toHaveLength(200);
  });

  it("serves the upstream script untouched on a healthy fetch (no failure action)", async () => {
    vi.mocked(safeFetch).mockResolvedValue(
      new Response("/* real script */", { status: 200 }) as never,
    );

    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("/* real script */");

    const failureCall = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          call[0]?.action?.name === "monitoring.umami_script.fetch_failed",
      );
    expect(failureCall).toBeUndefined();
  });
});
