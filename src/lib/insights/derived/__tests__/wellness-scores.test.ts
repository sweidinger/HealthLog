import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    strainTrimpCache: { findUnique: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  computeWellnessScore,
  bandWellnessScore,
  type WellnessScoreValue,
} from "../wellness-scores";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const cacheFindUnique = prisma.strainTrimpCache
  .findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  findMany.mockReset();
  cacheFindUnique.mockReset();
  cacheFindUnique.mockResolvedValue(null);
});

describe("bandWellnessScore", () => {
  it("higher is better for recovery", () => {
    expect(bandWellnessScore("RECOVERY_SCORE", 80)).toBe("green");
    expect(bandWellnessScore("RECOVERY_SCORE", 50)).toBe("yellow");
    expect(bandWellnessScore("RECOVERY_SCORE", 20)).toBe("red");
  });

  it("higher is worse for stress (band inverts)", () => {
    expect(bandWellnessScore("STRESS_SCORE", 80)).toBe("red");
    expect(bandWellnessScore("STRESS_SCORE", 50)).toBe("yellow");
    expect(bandWellnessScore("STRESS_SCORE", 20)).toBe("green");
  });
});

describe("computeWellnessScore", () => {
  it("returns insufficient with no_score_in_window when the job hasn't run", async () => {
    findMany.mockResolvedValue([]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.reason).toBe("no_score_in_window");
    }
  });

  it("reads the latest persisted score and a trailing trend", async () => {
    findMany.mockResolvedValue([
      { value: 72, measuredAt: new Date("2026-06-02T06:00:00Z") },
      { value: 60, measuredAt: new Date("2026-06-01T06:00:00Z") },
      { value: 64, measuredAt: new Date("2026-05-31T06:00:00Z") },
    ]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const v = r.value as WellnessScoreValue;
      expect(v.score).toBe(72);
      expect(v.band).toBe("green");
      // 72 - mean(60, 64) = 72 - 62 = 10
      expect(v.trendDelta).toBe(10);
      expect(v.daysInWindow).toBe(3);
      // Sparkline series: window rows oldest → newest (rows are read desc).
      expect(v.series).toEqual([64, 60, 72]);
    }
  });

  it("null trend when only one score exists", async () => {
    findMany.mockResolvedValue([
      { value: 40, measuredAt: new Date("2026-06-02T06:00:00Z") },
    ]);
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).trendDelta).toBeNull();
    }
  });

  it("STRAIN carries the active anchor from the day's cache row", async () => {
    findMany.mockResolvedValue([
      { value: 55, measuredAt: new Date("2026-06-01T12:00:00Z") },
    ]);
    cacheFindUnique.mockResolvedValue({ anchor: "personal" });
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    // The cache is keyed by the scored day (the latest score's day key).
    expect(cacheFindUnique).toHaveBeenCalledWith({
      where: { userId_day: { userId: "u1", day: "2026-06-01" } },
      select: { anchor: true },
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).anchor).toBe("personal");
    }
  });

  it("STRAIN anchor is null when no cache row exists", async () => {
    findMany.mockResolvedValue([
      { value: 55, measuredAt: new Date("2026-06-01T12:00:00Z") },
    ]);
    cacheFindUnique.mockResolvedValue(null);
    const r = await computeWellnessScore("STRAIN_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).anchor).toBeNull();
    }
  });

  it("RECOVERY does not read the strain cache and carries a null anchor", async () => {
    findMany.mockResolvedValue([
      { value: 72, measuredAt: new Date("2026-06-01T12:00:00Z") },
    ]);
    const r = await computeWellnessScore("RECOVERY_SCORE", "u1", PROFILE, {
      now: NOW,
    });
    expect(cacheFindUnique).not.toHaveBeenCalled();
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect((r.value as WellnessScoreValue).anchor).toBeNull();
    }
  });
});
