/**
 * v1.27.7 — unit tests for the hero score-ring resolver.
 *
 * The resolver is tested in isolation with the derived dispatcher and
 * the compliance engine mocked, pinning:
 *   - module gating (owning module + the insights gate on derived rings);
 *   - the pass-through contract for derived scores (same resolvers the
 *     batch route calls, no recomputation, non-`ok` → no ring);
 *   - the pooled 7-day adherence math (Σtaken / Σ(taken+missed), skips
 *     out of the denominator, empty denominator → no ring);
 *   - the adherence band thresholds (≥90 / ≥70 — the targets-tile rule);
 *   - per-ring fail-softness (one throwing engine drops only its ring).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeDerivedMetric = vi.fn();
const loadBaselineProfile = vi.fn();
const calculateCompliance = vi.fn();
const buildComplianceMedicationContext = vi.fn();
const lastNonSkippedTakenAt = vi.fn();

vi.mock("@/lib/insights/derived", () => ({
  computeDerivedMetric: (...a: unknown[]) => computeDerivedMetric(...a),
  loadBaselineProfile: (...a: unknown[]) => loadBaselineProfile(...a),
  isDerivedOk: (d: { status: string }) => d.status === "ok",
}));
vi.mock("@/lib/analytics/compliance", () => ({
  calculateCompliance: (...a: unknown[]) => calculateCompliance(...a),
  buildComplianceMedicationContext: (...a: unknown[]) =>
    buildComplianceMedicationContext(...a),
  lastNonSkippedTakenAt: (...a: unknown[]) => lastNonSkippedTakenAt(...a),
  SCHEDULE_COMPLIANCE_SELECT: { id: true },
}));

import { buildScoreRingsBlock, complianceBandForRate } from "../score-rings";
import type { ModuleKey } from "@/lib/modules/gate";

const NOW = new Date("2026-07-01T10:00:00.000Z");
const TZ = "Europe/Berlin";

function moduleMap(
  overrides: Partial<Record<ModuleKey, boolean>> = {},
): Record<ModuleKey, boolean> {
  return {
    recovery: true,
    sleep: true,
    medications: true,
    insights: true,
    ...overrides,
  } as Record<ModuleKey, boolean>;
}

const fakePrisma = {
  medication: { findMany: vi.fn() },
  medicationIntakeEvent: { findMany: vi.fn() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

/** A minimal medication row matching the resolver's select. */
function med(id: string) {
  return {
    id,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startsOn: null,
    endsOn: null,
    oneShot: false,
    schedules: [{ id: `${id}-s` }],
    scheduleRevisions: [],
    pauseEras: [],
  };
}

function complianceResult(taken: number, missed: number, skipped = 0) {
  return {
    totalExpected: taken + missed + skipped,
    taken,
    skipped,
    missed,
    rate: 0, // the resolver pools counts, never this per-med rate
    streak: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadBaselineProfile.mockResolvedValue({ userId: "user-1" });
  buildComplianceMedicationContext.mockReturnValue({ ctx: true });
  lastNonSkippedTakenAt.mockReturnValue(null);
  fakePrisma.medication.findMany.mockResolvedValue([]);
  fakePrisma.medicationIntakeEvent.findMany.mockResolvedValue([]);
});

describe("complianceBandForRate()", () => {
  it("bands on the targets-tile thresholds (≥90 green / ≥70 yellow / else red)", () => {
    expect(complianceBandForRate(100)).toBe("green");
    expect(complianceBandForRate(90)).toBe("green");
    expect(complianceBandForRate(89)).toBe("yellow");
    expect(complianceBandForRate(70)).toBe("yellow");
    expect(complianceBandForRate(69)).toBe("red");
    expect(complianceBandForRate(0)).toBe("red");
  });
});

describe("buildScoreRingsBlock() — selection + module gating", () => {
  it("returns [] for an empty selection without touching any engine", async () => {
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      [],
      moduleMap(),
      NOW,
    );
    expect(rings).toEqual([]);
    expect(loadBaselineProfile).not.toHaveBeenCalled();
    expect(computeDerivedMetric).not.toHaveBeenCalled();
    expect(fakePrisma.medication.findMany).not.toHaveBeenCalled();
  });

  it("drops rings whose owning module is disabled", async () => {
    computeDerivedMetric.mockResolvedValue({
      status: "ok",
      value: { score: 80, band: "green" },
    });
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["READINESS", "SLEEP_SCORE"],
      moduleMap({ recovery: false }),
      NOW,
    );
    expect(rings).toEqual([{ id: "SLEEP_SCORE", score: 80, band: "green" }]);
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "SLEEP_SCORE", userId: "user-1" }),
    );
  });

  it("the insights gate drops derived rings but keeps the adherence ring", async () => {
    fakePrisma.medication.findMany.mockResolvedValue([med("m1")]);
    calculateCompliance.mockReturnValue(complianceResult(9, 1));
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["READINESS", "MED_COMPLIANCE"],
      moduleMap({ insights: false }),
      NOW,
    );
    expect(computeDerivedMetric).not.toHaveBeenCalled();
    expect(loadBaselineProfile).not.toHaveBeenCalled();
    expect(rings).toEqual([{ id: "MED_COMPLIANCE", score: 90, band: "green" }]);
  });
});

describe("buildScoreRingsBlock() — derived rings", () => {
  it("passes through the engine's score + band (rounded) in selection order", async () => {
    computeDerivedMetric.mockImplementation(
      async ({ metric }: { metric: string }) =>
        metric === "READINESS"
          ? { status: "ok", value: { score: 71.6, band: "green" } }
          : { status: "ok", value: { score: 38, band: "red" } },
    );
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["RECOVERY_SCORE", "READINESS"],
      moduleMap(),
      NOW,
    );
    expect(rings).toEqual([
      { id: "RECOVERY_SCORE", score: 38, band: "red" },
      { id: "READINESS", score: 72, band: "green" },
    ]);
    // Profile loaded exactly once (the batch-route pattern).
    expect(loadBaselineProfile).toHaveBeenCalledTimes(1);
  });

  it("a non-ok compute yields no ring (self-gating, never a fabricated value)", async () => {
    computeDerivedMetric.mockResolvedValue({
      status: "insufficient",
      reason: "not_enough_history",
    });
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["SLEEP_SCORE"],
      moduleMap(),
      NOW,
    );
    expect(rings).toEqual([]);
  });

  it("a throwing engine drops only its own ring (fail-soft)", async () => {
    computeDerivedMetric.mockImplementation(
      async ({ metric }: { metric: string }) => {
        if (metric === "READINESS") throw new Error("engine down");
        return { status: "ok", value: { score: 55, band: "yellow" } };
      },
    );
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["READINESS", "SLEEP_SCORE"],
      moduleMap(),
      NOW,
    );
    expect(rings).toEqual([{ id: "SLEEP_SCORE", score: 55, band: "yellow" }]);
  });
});

describe("buildScoreRingsBlock() — pooled 7-day adherence", () => {
  it("pools Σtaken / Σ(taken+missed) across medications; skips stay out", async () => {
    fakePrisma.medication.findMany.mockResolvedValue([med("m1"), med("m2")]);
    calculateCompliance
      .mockReturnValueOnce(complianceResult(6, 1, 2)) // m1: skips ignored
      .mockReturnValueOnce(complianceResult(2, 3));
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["MED_COMPLIANCE"],
      moduleMap(),
      NOW,
    );
    // (6+2) / (6+1+2+3) = 8/12 = 66.67 → 67, red band.
    expect(rings).toEqual([{ id: "MED_COMPLIANCE", score: 67, band: "red" }]);
    // The 7-day window rides the canonical engine call.
    expect(calculateCompliance).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      7,
      expect.anything(),
      expect.objectContaining({ now: NOW }),
    );
  });

  it("no active non-PRN medication → no ring", async () => {
    fakePrisma.medication.findMany.mockResolvedValue([]);
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["MED_COMPLIANCE"],
      moduleMap(),
      NOW,
    );
    expect(rings).toEqual([]);
    expect(fakePrisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("zero expected doses in the window → no ring (never a hollow 100%)", async () => {
    fakePrisma.medication.findMany.mockResolvedValue([med("m1")]);
    calculateCompliance.mockReturnValue(complianceResult(0, 0, 0));
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      TZ,
      ["MED_COMPLIANCE"],
      moduleMap(),
      NOW,
    );
    expect(rings).toEqual([]);
  });
});
