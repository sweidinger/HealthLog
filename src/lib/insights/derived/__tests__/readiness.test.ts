import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "@/lib/db";
import {
  computeReadiness,
  blendReadinessComponents,
  scoreDeviation,
  READINESS_MIN_COMPONENTS,
  type ReadinessComponentKey,
} from "../readiness";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const measurementFindMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;
const moodFindMany = prisma.moodEntry.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  measurementFindMany.mockResolvedValue([]);
  moodFindMany.mockResolvedValue([]);
});

describe("scoreDeviation", () => {
  it("scores 100 on or in the good direction (lower-better)", () => {
    expect(scoreDeviation(50, 60, 5, "lower-better")).toBe(100);
    expect(scoreDeviation(60, 60, 5, "lower-better")).toBe(100);
  });

  it("suppresses the score one spread worse (lower-better RHR elevated)", () => {
    expect(scoreDeviation(65, 60, 5, "lower-better")).toBe(50);
    expect(scoreDeviation(70, 60, 5, "lower-better")).toBe(0);
  });

  it("suppresses on an HRV drop (higher-better)", () => {
    expect(scoreDeviation(55, 60, 5, "higher-better")).toBe(50);
    expect(scoreDeviation(65, 60, 5, "higher-better")).toBe(100);
  });

  it("degrades gracefully when the spread is zero", () => {
    expect(scoreDeviation(61, 60, 0, "lower-better")).toBe(50);
    expect(scoreDeviation(59, 60, 0, "lower-better")).toBe(100);
  });
});

describe("blendReadinessComponents reweighting", () => {
  it("renormalises over present components and drops missing ones", () => {
    const raw: Record<ReadinessComponentKey, number | null> = {
      rhr: 80,
      hrv: 70,
      sleep: null,
      respiratory: null,
      mood: 60,
    };
    const { score, components } = blendReadinessComponents(raw);
    const sleep = components.find((c) => c.key === "sleep")!;
    expect(sleep.weight).toBe(0);
    const presentSum = components
      .filter((c) => c.value !== null)
      .reduce((s, c) => s + c.weight, 0);
    expect(presentSum).toBeCloseTo(1, 5);
    expect(score).toBeGreaterThan(0);
  });
});

describe("computeReadiness gating", () => {
  it("returns insufficient below the minimum-components floor (no 1-of-N headline)", async () => {
    // No data at all → 0 components present.
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("insufficient_components");
      expect(result.coverage.presentInputs).toBeLessThan(
        READINESS_MIN_COMPONENTS,
      );
    }
  });

  it("produces a headline once ≥ 2 deviation components are present", async () => {
    // RHR + HRV baselines: ≥ 7 distinct days each, plus a latest reading.
    const days = (type: string, base: number) =>
      Array.from({ length: 10 }, (_, i) => ({
        value: base,
        // 10 distinct days within May (15..24) — all valid calendar days.
        measuredAt: new Date(`2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`),
        type,
      }));
    measurementFindMany.mockImplementation(
      async (args: { where: { type: string } }) => {
        const type = args.where.type;
        if (type === "RESTING_HEART_RATE") return days(type, 58);
        if (type === "HEART_RATE_VARIABILITY") return days(type, 65);
        return [];
      },
    );
    const result = await computeReadiness("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const present = result.value.components.filter((c) => c.value !== null);
      expect(present.length).toBeGreaterThanOrEqual(READINESS_MIN_COMPONENTS);
      expect(result.value.score).toBeGreaterThanOrEqual(0);
      expect(result.value.score).toBeLessThanOrEqual(100);
    }
  });
});
