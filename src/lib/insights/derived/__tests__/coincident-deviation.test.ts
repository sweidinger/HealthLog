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
// v1.18.1 P4 — Rest Mode. Default inactive; the reframe test flips it active.
const restModeMock = vi.hoisted(() => ({
  resolveRestMode: vi.fn(async () => ({
    active: false as boolean,
    since: null as string | null,
    episodeCount: 0,
    episodes: [] as unknown[],
  })),
}));
vi.mock("@/lib/illness/rest-mode", () => restModeMock);

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
  restModeMock.resolveRestMode.mockResolvedValue({
    active: false,
    since: null,
    episodeCount: 0,
    episodes: [],
  });
});

/** RHR + HRV each flat, then a final day that pushes both outside the band. */
function firingRows(args: { where: { type: string } }) {
  const baseline = (base: number, outlier: number) => [
    ...Array.from({ length: 9 }, (_, i) => ({
      value: base,
      measuredAt: new Date(
        `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
      ),
    })),
    { value: outlier, measuredAt: new Date("2026-06-02T07:00:00Z") },
  ];
  if (args.where.type === "RESTING_HEART_RATE") return baseline(58, 95);
  if (args.where.type === "HEART_RATE_VARIABILITY") return baseline(60, 10);
  return [];
}

/** RHR + HRV each flat (banded but inside) — the no-fire-but-banded case. */
function quietBandedRows(args: { where: { type: string } }) {
  const flat = (base: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      value: base,
      measuredAt: new Date(
        `2026-05-${String(15 + i).padStart(2, "0")}T07:00:00Z`,
      ),
    }));
  if (args.where.type === "RESTING_HEART_RATE") return flat(58);
  if (args.where.type === "HEART_RATE_VARIABILITY") return flat(60);
  return [];
}

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
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
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
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
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
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.fired).toBe(false);
    }
  });

  it("reframes a fired flag as illness-explained during Rest Mode (vitals unchanged)", async () => {
    restModeMock.resolveRestMode.mockResolvedValue({
      active: true,
      since: "2026-05-30T00:00:00.000Z",
      episodeCount: 1,
      episodes: [],
    });
    findMany.mockImplementation(firingRows);
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.fired).toBe(true);
      // Reframed — but the measured deviations are untouched.
      expect(result.value.illnessExplained).toBe(true);
      expect(result.value.contributing.length).toBeGreaterThanOrEqual(
        COINCIDENT_FIRE_THRESHOLD,
      );
    }
  });

  it("does not resolve Rest Mode (no reframe) when the flag did not fire", async () => {
    // Banded but inside-band: the reframe must not even query Rest Mode.
    findMany.mockImplementation(quietBandedRows);
    const result = await computeCoincidentDeviation("u1", PROFILE, {
      now: NOW,
    });
    expect(result.status === "ok" && result.value.fired).toBe(false);
    expect(result.status === "ok" && result.value.illnessExplained).toBe(false);
    expect(restModeMock.resolveRestMode).not.toHaveBeenCalled();
  });
});
