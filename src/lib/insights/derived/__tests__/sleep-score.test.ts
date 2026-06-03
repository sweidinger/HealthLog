import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: vi.fn() } },
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));

import { prisma } from "@/lib/db";
import { resolveUserTimezone } from "@/lib/tz/resolver";
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
  circularMinuteDistance,
  circularMeanMinutes,
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

  it("efficiency handles asleep > in-bed overlap explicitly, not via a blind clamp", () => {
    // A small overshoot (≤ 5 %, overlapping HK stages) caps at the AASM
    // ceiling of 100 rather than reporting > 100 %.
    expect(scoreEfficiency(485, 480)).toBe(100); // ~101 % → 100
    // A gross overshoot means the in-bed denominator is not usable — drop the
    // sub-score (null) rather than masking the data problem with a fake 100.
    expect(scoreEfficiency(600, 480)).toBeNull(); // 125 % → unusable
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

  it("circular distance wraps across midnight (mod 1440)", () => {
    // 23:50 (1430) and 00:10 (10) are 20 min apart, not 1420.
    expect(circularMinuteDistance(1430, 10)).toBe(20);
    expect(circularMinuteDistance(10, 1430)).toBe(20);
    // Within-day distance unchanged.
    expect(circularMinuteDistance(100, 160)).toBe(60);
  });

  it("circular mean of midnight-straddling midpoints stays near midnight", () => {
    // 23:50, 00:10, 00:00 cluster around midnight; a linear mean would
    // collapse to ~08:00 (480). The circular mean stays near 0/1440.
    const mean = circularMeanMinutes([1430, 10, 0])!;
    const distFromMidnight = Math.min(mean, 1440 - mean);
    expect(distFromMidnight).toBeLessThan(20);
  });

  it("consistency does NOT penalise a midnight-straddling sleeper", () => {
    // Tight cluster around midnight: circular SD is small → high score. A
    // linear SD would read a spurious ~24-h spread → 0.
    const score = scoreConsistency([1430, 10, 0, 1435, 5])!;
    expect(score).toBeGreaterThan(80);
  });

  it("timing uses circular distance across the wrap", () => {
    // Night midpoint 00:05 (5) vs habitual 23:55 (1435) is 10 min off (NOT
    // 1430), so the score stays high. A linear distance would read ~1430 →
    // clamp to 0.
    const wrapped = scoreTiming(5, 1435, 5)!;
    expect(wrapped).toBeGreaterThan(85);
    // 10 min off the habitual midpoint within the day scores identically.
    expect(scoreTiming(100, 110, 5)).toBe(wrapped);
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

  it("expresses the midpoint in UTC by default", () => {
    // Earliest 01:00Z, latest 05:00Z → midpoint 03:00Z = 180 min-of-day.
    const rows = night("2026-06-02", [
      ["CORE", 120, "01:00"],
      ["CORE", 120, "05:00"],
    ]);
    const nights = reconstructNights(rows);
    expect(nights[0].midpoint).toBe(180);
  });

  it("expresses the midpoint in the user's timezone when one is passed", () => {
    // Same 03:00Z midpoint, read in Asia/Kolkata (UTC+5:30, no DST) →
    // 08:30 local = 510 min-of-day, not 180.
    const rows = night("2026-06-02", [
      ["CORE", 120, "01:00"],
      ["CORE", 120, "05:00"],
    ]);
    const nights = reconstructNights(rows, "Asia/Kolkata");
    expect(nights[0].midpoint).toBe(8 * 60 + 30);
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

  it("threads an explicit tz into the midpoint without resolving the user zone", async () => {
    const rows = [
      ...night("2026-05-31", [
        ["CORE", 240, "03:00"],
        ["DEEP", 60, "04:00"],
      ]),
      ...night("2026-06-01", [
        ["CORE", 250, "03:10"],
        ["DEEP", 55, "04:10"],
      ]),
      ...night("2026-06-02", [
        ["CORE", 235, "03:05"],
        ["DEEP", 65, "04:05"],
      ]),
    ];
    findMany.mockResolvedValue(rows);
    // A pinned tz must score without falling back to the user-zone resolver.
    const result = await computeSleepScore("u1", PROFILE, {
      now: NOW,
      tz: "Asia/Kolkata",
    });
    expect(result.status).toBe("ok");
    expect(resolveUserTimezone).not.toHaveBeenCalled();
  });
});
