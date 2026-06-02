import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/insights/derived")>();
  return { ...actual, computeDerivedMetric: vi.fn() };
});

import { computeDerivedMetric } from "@/lib/insights/derived";
import { buildDerivedSnapshotBlock } from "../derived-snapshot";

const compute = computeDerivedMetric as unknown as ReturnType<typeof vi.fn>;
const PROFILE = { ageYears: 40, sex: "MALE" as const, heightCm: 180 };
const NOW = new Date("2026-06-02T08:00:00Z");

function ok(value: Record<string, unknown>, historyDays = 14) {
  return {
    status: "ok" as const,
    value,
    coverage: { requiredInputs: 1, presentInputs: 1, historyDays, missing: [] },
    confidence: { score: 88, band: "high" as const },
    provenance: { inputs: [], source: "DAY" as const, windowDays: 14, computedAt: "x" },
  };
}
const insufficient = {
  status: "insufficient" as const,
  coverage: { requiredInputs: 1, presentInputs: 0, historyDays: 0, missing: [] },
  provenance: { inputs: [], source: "none" as const, windowDays: 0, computedAt: "x" },
  reason: "no_score_in_window",
};

beforeEach(() => compute.mockReset());

describe("buildDerivedSnapshotBlock", () => {
  it("returns null when every metric is insufficient", async () => {
    compute.mockResolvedValue(insufficient);
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).toBeNull();
  });

  it("emits compact value + band + confidence per ok metric, omits insufficient", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS") return ok({ score: 64, band: "yellow" });
      if (args?.metric === "RECOVERY_SCORE") return ok({ score: 72, band: "green" });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).not.toBeNull();
    expect(Object.keys(block!).sort()).toEqual(["READINESS", "RECOVERY_SCORE"]);
    expect(block!.READINESS).toEqual({
      value: 64,
      band: "yellow",
      confidence: 88,
      historyDays: 14,
    });
    // No raw series leaked — only the four compact facets.
    expect(Object.keys(block!.READINESS).sort()).toEqual([
      "band",
      "confidence",
      "historyDays",
      "value",
    ]);
  });

  it("isolates a per-metric compute failure", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS") throw new Error("boom");
      if (args?.metric === "SLEEP_SCORE") return ok({ score: 80, band: "green" });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).toEqual({
      SLEEP_SCORE: { value: 80, band: "green", confidence: 88, historyDays: 14 },
    });
  });
});
