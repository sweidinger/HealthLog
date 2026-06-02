import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import {
  computeSleepScore,
  blendSleepSubScores,
  reconstructNights,
  sleepNeedMinutes,
  scoreSufficiency,
  scoreEfficiency,
  scoreComposition,
  scoreConsistency,
  scoreTiming,
  type SleepSubScoreKey,
} from "../sleep-score";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

/** Build per-stage rows for one night keyed on a wake-day. */
function night(day: string, stages: Array<[string | null, number, string]>) {
  return stages.map(([sleepStage, value, hhmm]) => ({
    value,
    measuredAt: new Date(`${day}T${hhmm}:00Z`),
    sleepStage: sleepStage as never,
  }));
}

describe("pure sleep scorers", () => {
  it("sleepNeedMinutes is age-banded with an adult default", () => {
    expect(sleepNeedMinutes(40)).toBe(7 * 60);
    expect(sleepNeedMinutes(10)).toBe(10 * 60);
    expect(sleepNeedMinutes(null)).toBe(7 * 60);
  });

  it("sufficiency caps at 100 and never penalises oversleep", () => {
    expect(scoreSufficiency(7 * 60, 7 * 60)).toBe(100);
    expect(scoreSufficiency(10 * 60, 7 * 60)).toBe(100);
    expect(scoreSufficiency(3.5 * 60, 7 * 60)).toBe(50);
  });

  it("efficiency is null without in-bed minutes, else the asleep ratio", () => {
    expect(scoreEfficiency(420, null)).toBeNull();
    expect(scoreEfficiency(420, 480)).toBe(88);
  });

  it("composition is null without a stage breakdown, 100 inside the band", () => {
    expect(scoreComposition(0, 0, 420, false)).toBeNull();
    // REM 90 + Deep 60 = 150 of 420 ≈ 0.357 — inside [0.33, 0.48].
    expect(scoreComposition(90, 60, 420, true)).toBe(100);
  });

  it("consistency is null below 3 nights, 100 for a flat midpoint", () => {
    expect(scoreConsistency([100, 100])).toBeNull();
    expect(scoreConsistency([180, 180, 180])).toBe(100);
  });

  it("timing is null without a habitual window", () => {
    expect(scoreTiming(180, null, 1)).toBeNull();
    expect(scoreTiming(180, 180, 5)).toBe(100);
  });
});

describe("blendSleepSubScores reweighting", () => {
  it("renormalises weights over the present sub-scores (drops a missing one)", () => {
    const raw: Record<SleepSubScoreKey, number | null> = {
      sufficiency: 80,
      efficiency: 90,
      consistency: 70,
      timing: 60,
      composition: null, // legacy ASLEEP-only night
    };
    const { score, subScores } = blendSleepSubScores(raw);
    const composition = subScores.find((s) => s.key === "composition")!;
    expect(composition.weight).toBe(0);
    // Present weights sum to 1.
    const sum = subScores.reduce((s, c) => s + c.weight, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe("reconstructNights", () => {
  it("sums asleep stages, derives in-bed, flags the stage breakdown", () => {
    const rows = night("2026-06-02", [
      ["IN_BED", 480, "06:00"],
      ["REM", 90, "02:00"],
      ["CORE", 240, "03:00"],
      ["DEEP", 60, "04:00"],
      ["AWAKE", 30, "05:00"],
    ]);
    const nights = reconstructNights(rows);
    expect(nights).toHaveLength(1);
    expect(nights[0].asleepMinutes).toBe(390);
    expect(nights[0].inBedMinutes).toBe(480);
    expect(nights[0].hasStageBreakdown).toBe(true);
    expect(nights[0].remMinutes).toBe(90);
    expect(nights[0].deepMinutes).toBe(60);
  });
});

describe("computeSleepScore", () => {
  it("returns insufficient when no sleep rows exist", async () => {
    findMany.mockResolvedValue([]);
    const result = await computeSleepScore("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_sleep_in_window");
    }
  });

  it("scores a multi-stage night and shows the present sub-scores", async () => {
    // Three nights so consistency/timing can compute.
    const rows = [
      ...night("2026-05-31", [
        ["IN_BED", 480, "06:00"],
        ["REM", 90, "02:00"],
        ["CORE", 240, "03:00"],
        ["DEEP", 60, "04:00"],
      ]),
      ...night("2026-06-01", [
        ["IN_BED", 470, "06:10"],
        ["REM", 85, "02:10"],
        ["CORE", 250, "03:10"],
        ["DEEP", 55, "04:10"],
      ]),
      ...night("2026-06-02", [
        ["IN_BED", 480, "06:05"],
        ["REM", 95, "02:05"],
        ["CORE", 235, "03:05"],
        ["DEEP", 65, "04:05"],
      ]),
    ];
    findMany.mockResolvedValue(rows);
    const result = await computeSleepScore("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBeGreaterThan(0);
      expect(result.value.windowNights).toBe(3);
      // All five sub-scores present on a full-stage multi-night history.
      const present = result.value.subScores.filter((s) => s.value !== null);
      expect(present.length).toBe(5);
      expect(result.coverage.presentInputs).toBe(5);
    }
  });

  it("reweights around composition on a legacy ASLEEP-only night", async () => {
    const rows = [
      ...night("2026-05-31", [["ASLEEP", 420, "06:00"]]),
      ...night("2026-06-01", [["ASLEEP", 430, "06:10"]]),
      ...night("2026-06-02", [["ASLEEP", 410, "06:05"]]),
    ];
    findMany.mockResolvedValue(rows);
    const result = await computeSleepScore("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const composition = result.value.subScores.find(
        (s) => s.key === "composition",
      )!;
      expect(composition.value).toBeNull();
      expect(composition.weight).toBe(0);
      expect(result.coverage.missing).toContain("composition");
    }
  });
});
