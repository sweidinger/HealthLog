import { describe, it, expect, vi, beforeEach } from "vitest";

const computeVitalsBaseline = vi.fn();
vi.mock("../baseline", () => ({
  computeVitalsBaseline: (...a: unknown[]) => computeVitalsBaseline(...a),
}));

import { computeHrvBalance, placeHrvBalance } from "../hrv-balance";

const NOW = new Date("2026-06-02T07:00:00Z");
const PROFILE = { ageYears: 40, sex: "MALE" as const };

beforeEach(() => vi.clearAllMocks());

describe("placeHrvBalance", () => {
  it("low below the band floor", () => {
    expect(placeHrvBalance(30, 40, 80)).toBe("low");
  });
  it("balanced inside the band", () => {
    expect(placeHrvBalance(60, 40, 80)).toBe("balanced");
  });
  it("unbalanced above the band ceiling", () => {
    expect(placeHrvBalance(90, 40, 80)).toBe("unbalanced");
  });
});

describe("computeHrvBalance", () => {
  it("passes the baseline insufficient through verbatim", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "insufficient",
      coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 3, missing: [] },
      provenance: { inputs: ["HEART_RATE_VARIABILITY"], source: "DAY", windowDays: 30, computedAt: "x" },
      reason: "insufficient_history_for_band",
    });
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.reason).toBe("insufficient_history_for_band");
      expect(r.coverage.historyDays).toBe(3);
    }
  });

  it("builds a balanced band off the baseline center", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "ok",
      value: { type: "HEART_RATE_VARIABILITY", center: 60, low: 40, high: 80, spread: 20, sampleDays: 21, k: 3 },
      coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 21, missing: [] },
      confidence: { score: 70, band: "medium" },
      provenance: { inputs: ["HEART_RATE_VARIABILITY"], source: "DAY", windowDays: 30, computedAt: "x" },
    });
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.band).toBe("balanced");
      expect(r.value.recentAvg).toBe(60);
      expect(r.value.baselineLow).toBe(40);
      expect(r.value.baselineHigh).toBe(80);
      expect(r.value.sampleDays).toBe(21);
    }
  });
});
