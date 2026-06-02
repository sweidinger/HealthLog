import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: vi.fn() } },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "@/lib/db";
import {
  computeCoincidentDeviation,
  classifyDeviation,
  COINCIDENT_FIRE_THRESHOLD,
} from "../coincident-deviation";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T08:00:00Z");
const findMany = prisma.measurement.findMany as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
});

describe("classifyDeviation", () => {
  it("flags above / below / in-band", () => {
    expect(classifyDeviation("PULSE", 90, 60, 80, 70).direction).toBe("above");
    expect(classifyDeviation("PULSE", 50, 60, 80, 70).direction).toBe("below");
    expect(classifyDeviation("PULSE", 70, 60, 80, 70).direction).toBe("in");
    expect(classifyDeviation("PULSE", 70, 60, 80, 70).outside).toBe(false);
  });
});

describe("computeCoincidentDeviation", () => {
  it("returns insufficient with fewer than two banded vitals", async () => {
    // Only one vital has a usable band.
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") {
        return Array.from({ length: 10 }, (_, i) => ({
          value: 58,
          measuredAt: new Date(
            `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
          ),
        }));
      }
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_banded_vitals");
    }
  });

  it("fires when ≥ 2 vitals sit outside their band on the latest day", async () => {
    // RHR + HRV each have a flat band, then a final outlier day that
    // pushes both outside the band.
    const baseline = (
      base: number,
      outlier: number,
    ): Array<{ value: number; measuredAt: Date }> => [
      ...Array.from({ length: 9 }, (_, i) => ({
        value: base,
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
      })),
      { value: outlier, measuredAt: new Date("2026-06-02T07:00:00Z") },
    ];
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") return baseline(58, 95);
      if (args.where.type === "HEART_RATE_VARIABILITY") return baseline(60, 10);
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.contributing.length).toBeGreaterThanOrEqual(
        COINCIDENT_FIRE_THRESHOLD,
      );
      expect(result.value.fired).toBe(true);
    }
  });

  it("does not fire when vitals stay inside their bands", async () => {
    const flat = (base: number): Array<{ value: number; measuredAt: Date }> =>
      Array.from({ length: 10 }, (_, i) => ({
        value: base,
        measuredAt: new Date(
          `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
        ),
      }));
    findMany.mockImplementation(async (args: { where: { type: string } }) => {
      if (args.where.type === "RESTING_HEART_RATE") return flat(58);
      if (args.where.type === "HEART_RATE_VARIABILITY") return flat(60);
      return [];
    });
    const result = await computeCoincidentDeviation("u1", PROFILE, { now: NOW });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.fired).toBe(false);
    }
  });
});
