/**
 * v1.21.0 (C3) — the Coach correlations reader surfaces the deterministic FDR
 * discovery + coincident-deviation flag, returns descriptive driver rows, and
 * degrades to a clean { present: false } when nothing survives or a read fails.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const measurementFindMany = vi.fn();
const moodFindMany = vi.fn();
const userFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: (a: unknown) => measurementFindMany(a) },
    moodEntry: { findMany: (a: unknown) => moodFindMany(a) },
    user: { findUnique: (a: unknown) => userFindUnique(a) },
  },
}));

const loadBaselineProfile = vi.fn();
const computeCoincidentDeviation = vi.fn();
vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return {
    ...actual,
    loadBaselineProfile: () => loadBaselineProfile(),
    computeCoincidentDeviation: () => computeCoincidentDeviation(),
  };
});

const discoverCorrelations = vi.fn();
vi.mock("@/lib/insights/correlation-discovery", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/insights/correlation-discovery")
    >();
  return { ...actual, discoverCorrelations: () => discoverCorrelations() };
});

import { readCoachCorrelations } from "@/lib/ai/coach/tools/correlations-read";

describe("readCoachCorrelations", () => {
  beforeEach(() => {
    measurementFindMany.mockReset().mockResolvedValue([]);
    moodFindMany.mockReset().mockResolvedValue([]);
    userFindUnique.mockReset().mockResolvedValue({ timezone: "Europe/Berlin" });
    loadBaselineProfile
      .mockReset()
      .mockResolvedValue({ ageYears: 40, sex: "MALE", heightCm: 180 });
    computeCoincidentDeviation.mockReset().mockResolvedValue(null);
    discoverCorrelations.mockReset();
  });

  it("returns descriptive drivers when pairs survive", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [
        {
          behaviour: "TIME_IN_DAYLIGHT",
          outcome: "SLEEP_DURATION",
          n: 42,
          r: 0.34,
          pValue: 0.001,
          qValue: 0.02,
          interpretation:
            "Higher time in daylight tends to go with higher next-day sleep duration in your data — a pattern worth watching, not a cause.",
          lagDays: 1,
        },
      ],
      pairsTested: 18,
      fdrQ: 0.1,
      minPairs: 20,
    });
    const result = await readCoachCorrelations("u1");
    expect(result.present).toBe(true);
    expect(result.drivers).toHaveLength(1);
    expect(result.drivers?.[0]).toMatchObject({
      behaviour: "time in daylight",
      outcome: "sleep duration",
      direction: "higher",
      lagDays: 1,
      n: 42,
    });
    expect(result.pairsTested).toBe(18);
  });

  it("returns present:false when nothing survives and no coincident flag", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [],
      pairsTested: 4,
      fdrQ: 0.1,
      minPairs: 20,
    });
    const result = await readCoachCorrelations("u1");
    expect(result.present).toBe(false);
    expect(result.reason).toBe("no_significant_pattern");
  });

  it("surfaces a fired coincident flag even without drivers", async () => {
    discoverCorrelations.mockReturnValue({
      discovered: [],
      pairsTested: 4,
      fdrQ: 0.1,
      minPairs: 20,
    });
    computeCoincidentDeviation.mockResolvedValue({
      status: "ok",
      value: {
        fired: true,
        vitals: [],
        contributing: [
          { type: "RESTING_HEART_RATE", direction: "above" },
          { type: "HEART_RATE_VARIABILITY", direction: "below" },
        ],
        day: "2026-06-02",
        illnessExplained: false,
      },
      coverage: {
        requiredInputs: 2,
        presentInputs: 2,
        historyDays: 30,
        missing: [],
      },
      confidence: { score: 80, band: "high" },
      provenance: {
        inputs: [],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    const result = await readCoachCorrelations("u1");
    expect(result.present).toBe(true);
    expect(result.coincident?.fired).toBe(true);
    expect(result.coincident?.contributing).toEqual([
      { metric: "resting heart rate", direction: "above" },
      { metric: "heart rate variability", direction: "below" },
    ]);
  });

  it("degrades to present:false on a read failure", async () => {
    loadBaselineProfile.mockRejectedValue(new Error("db down"));
    const result = await readCoachCorrelations("u1");
    expect(result.present).toBe(false);
    expect(result.reason).toBe("retrieval_failed");
  });
});
