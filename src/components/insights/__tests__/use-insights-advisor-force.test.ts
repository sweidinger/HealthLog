/**
 * v1.28.30 — wire-contract for the explicit regenerate.
 *
 * House rule: generation = nightly cron + explicit button. The button's
 * mutation therefore MUST issue `POST { force: true }` — without `force`
 * the route's 24 h short-circuit re-serves the cached payload and the
 * button reads as doing nothing (one half of the recurring
 * "no briefing today" chain). The read path stays a plain GET.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetchRaw = vi.fn();

vi.mock("@/lib/api/api-fetch", () => ({
  apiFetchRaw: (...a: unknown[]) => apiFetchRaw(...a),
}));

import { fetchAdvisor } from "../use-insights-advisor";

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchRaw.mockResolvedValue(
    jsonResponse({ insights: { dailyBriefing: null }, cached: false }),
  );
});

describe("fetchAdvisor — explicit regenerate forces a generation", () => {
  it("POSTs force: true on the regenerate path", async () => {
    const result = await fetchAdvisor({ force: true });

    expect(apiFetchRaw).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchRaw.mock.calls[0] as [
      string,
      { method: string; body?: string },
    ];
    expect(url).toBe("/api/insights/generate");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body ?? "{}")).toEqual({ force: true });
    expect(result.outcome).toBe("fresh");
  });

  it("uses a read-only GET (no body, no force) on the read path", async () => {
    await fetchAdvisor();

    expect(apiFetchRaw).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchRaw.mock.calls[0] as [
      string,
      { method: string; body?: string },
    ];
    expect(url).toBe("/api/insights/generate");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("lifts briefingOmittedReason through the payload for the card", async () => {
    apiFetchRaw.mockResolvedValue(
      jsonResponse({
        insights: { dailyBriefing: null },
        cached: true,
        briefingOmittedReason: "ungrounded",
      }),
    );

    const result = await fetchAdvisor();
    expect(result.payload?.briefingOmittedReason).toBe("ungrounded");
    expect(result.payload?.dailyBriefing).toBeNull();
  });
});
