import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/insights/derived")>();
  return { ...actual, computeTrajectory: vi.fn() };
});

import { computeTrajectory, TRAJECTORY_TYPES } from "@/lib/insights/derived";
import { buildTrajectorySnapshotBlock } from "@/lib/ai/coach/trajectory-snapshot";

const compute = computeTrajectory as unknown as ReturnType<typeof vi.fn>;
const PROFILE = { ageYears: 40, sex: "MALE" as const, heightCm: 180 };
const NOW = new Date("2026-06-02T08:00:00Z");
const TYPE = TRAJECTORY_TYPES[0];

function okTrajectory(type: string) {
  return {
    status: "ok" as const,
    value: {
      type,
      slopePerDay: 0.123,
      direction: "up" as const,
      horizonDays: 14,
      r2: 0.4567,
      residualStdError: 1.2,
      sampleDays: 20,
      lastValue: 61.44,
      projection: [
        { dayOffset: 1, date: "2026-06-03", projected: 61.5, bandLow: 60.1, bandHigh: 62.9 },
        { dayOffset: 14, date: "2026-06-16", projected: 63.16, bandLow: 60.02, bandHigh: 66.34 },
      ],
      method: "ols" as const,
    },
    coverage: { requiredInputs: 1, presentInputs: 1, historyDays: 20, missing: [] },
    confidence: { score: 71, band: "moderate" as const },
    provenance: { inputs: [type], source: "DAY" as const, windowDays: 30, computedAt: "x" },
  };
}
const insufficient = {
  status: "insufficient" as const,
  coverage: { requiredInputs: 1, presentInputs: 0, historyDays: 4, missing: [] },
  provenance: { inputs: [], source: "none" as const, windowDays: 30, computedAt: "x" },
  reason: "insufficient_fit_for_projection",
};

describe("buildTrajectorySnapshotBlock", () => {
  it("omits the block entirely when every metric is insufficient", async () => {
    compute.mockReset();
    compute.mockResolvedValue(insufficient);
    const block = await buildTrajectorySnapshotBlock("u1", PROFILE, NOW);
    expect(block).toBeNull();
  });

  it("emits a compact projection only for an ok metric, reading the engine's numbers", async () => {
    compute.mockReset();
    compute.mockImplementation(
      async (_userId: string, _profile: unknown, opts: { type: string }) =>
        opts.type === TYPE ? okTrajectory(opts.type) : insufficient,
    );
    const block = await buildTrajectorySnapshotBlock("u1", PROFILE, NOW);
    expect(block).not.toBeNull();
    expect(Object.keys(block!)).toEqual([TYPE]);
    expect(block![TYPE]).toEqual({
      direction: "up",
      slopePerDay: 0.1,
      horizonDays: 14,
      lastValue: 61.4,
      projectedEnd: { value: 63.2, bandLow: 60, bandHigh: 66.3 },
      r2: 0.46,
      confidence: 71,
    });
    // The horizon END (last projection point) is what's surfaced — the
    // full fan never leaks into the prompt.
    expect(Object.keys(block![TYPE]).sort()).toEqual([
      "confidence",
      "direction",
      "horizonDays",
      "lastValue",
      "projectedEnd",
      "r2",
      "slopePerDay",
    ]);
  });

  it("isolates a per-metric compute failure", async () => {
    compute.mockReset();
    compute.mockImplementation(
      async (_userId: string, _profile: unknown, opts: { type: string }) => {
        if (opts.type === TRAJECTORY_TYPES[0]) throw new Error("boom");
        if (opts.type === TRAJECTORY_TYPES[1]) return okTrajectory(opts.type);
        return insufficient;
      },
    );
    const block = await buildTrajectorySnapshotBlock("u1", PROFILE, NOW);
    expect(block).not.toBeNull();
    expect(Object.keys(block!)).toEqual([TRAJECTORY_TYPES[1]]);
  });
});
