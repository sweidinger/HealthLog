import { describe, it, expect } from "vitest";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";

describe("returnTimeoutFallback", () => {
  it("reports hasProvider:false so a deterministic fallback is never mislabelled as a fresh AI assessment", () => {
    const result = returnTimeoutFallback({
      cacheAction: "insights.pulse-status.en",
      reason: "timeout",
      stubText: "Your resting pulse is at 72 bpm right now.",
      // No userId/todayKey → no negative-stub write, pure render path.
    });
    expect(result.hasProvider).toBe(false);
    expect(result.cached).toBe(true);
    expect(result.updatedAt).toBeNull();
    expect(result.text).toContain("72 bpm");
  });

  it("passes the grounded stub text through verbatim on an error", () => {
    const stub = "Your blood pressure is at 128 right now.";
    const result = returnTimeoutFallback({
      cacheAction: "insights.blood-pressure-status.en",
      reason: "error",
      stubText: stub,
    });
    expect(result.text).toBe(stub);
    expect(result.hasProvider).toBe(false);
  });
});
