import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB so the builder is hermetic — we control the rows.
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
vi.mock("../baseline", () => ({
  // 40-year-old adult → sleepNeedMinutes returns 420 (7 h).
  loadBaselineProfile: vi.fn(async () => ({
    ageYears: 40,
    sex: null,
    heightCm: null,
  })),
}));

// Spy on the foundation modules WITHOUT replacing the math — assert reuse.
import * as sleepDebtMod from "../sleep-debt";
import * as chronotypeMod from "../chronotype";

import { buildSleepRhythm, defaultDayType } from "../sleep-rhythm";

/**
 * Build per-stage rows for one night: a single bare-ASLEEP block whose END is
 * the wake instant, so `reconstructNights` reads asleep = `asleepMinutes` and a
 * midpoint at wake − asleep/2. `wakeIso` is the wake instant (UTC).
 */
function nightRows(wakeIso: string, asleepMinutes: number) {
  return [
    {
      value: asleepMinutes,
      measuredAt: new Date(wakeIso),
      sleepStage: "ASLEEP" as const,
      source: null,
      deviceType: null,
    },
  ];
}

describe("defaultDayType", () => {
  it("tags weekend wake days free and weekdays work (UTC)", () => {
    // 2026-06-13 is a Saturday, 2026-06-14 a Sunday, 2026-06-15 a Monday.
    expect(defaultDayType("2026-06-13", "UTC")).toBe("free");
    expect(defaultDayType("2026-06-14", "UTC")).toBe("free");
    expect(defaultDayType("2026-06-15", "UTC")).toBe("work");
  });
});

describe("buildSleepRhythm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the foundation modules — calls computeSleepDebt + computeChronotype", async () => {
    const debtSpy = vi.spyOn(sleepDebtMod, "computeSleepDebt");
    const chronoSpy = vi.spyOn(chronotypeMod, "computeChronotype");

    // Two scorable nights — enough to exercise the call, not the ready gate.
    findMany.mockResolvedValue([
      ...nightRows("2026-06-13T06:00:00Z", 360),
      ...nightRows("2026-06-14T06:00:00Z", 400),
    ]);

    const dto = await buildSleepRhythm("user-1", {
      tz: "UTC",
      now: new Date("2026-06-14T12:00:00Z"),
    });

    expect(debtSpy).toHaveBeenCalledTimes(1);
    expect(chronoSpy).toHaveBeenCalledTimes(1);
    // The need forwarded to the debt module is the age-resolved 420 (7 h).
    expect(debtSpy.mock.calls[0][1]).toBe(420);
    expect(dto.sleepDebt.needMinutes).toBe(420);
    // Below the 7-night floor → calm partial / learning, never an assertion.
    expect(dto.sleepDebt.state).toBe("partial");
    expect(dto.chronotype.state).toBe("learning");
  });

  it("forwards the canonical asleep totals into the debt deficit", async () => {
    // need 420; a 300-min night is 120 short, a 420-min night exactly meets it.
    findMany.mockResolvedValue([
      ...nightRows("2026-06-13T06:00:00Z", 300),
      ...nightRows("2026-06-14T06:00:00Z", 420),
    ]);
    const dto = await buildSleepRhythm("user-1", {
      tz: "UTC",
      now: new Date("2026-06-14T12:00:00Z"),
    });
    // Partial (< 7 nights) but the cumulative is still computed: 120 + 0.
    expect(dto.sleepDebt.debtMinutes).toBe(120);
    expect(dto.sleepDebt.nightsCounted).toBe(2);
    expect(dto.sleepDebt.nightsUntilReady).toBe(5);
  });

  it("returns calm states with zero nights", async () => {
    findMany.mockResolvedValue([]);
    const dto = await buildSleepRhythm("user-1", {
      tz: "UTC",
      now: new Date("2026-06-14T12:00:00Z"),
    });
    expect(dto.sleepDebt.state).toBe("partial");
    expect(dto.sleepDebt.nightsCounted).toBe(0);
    expect(dto.chronotype.state).toBe("learning");
    expect(dto.chronotype.band).toBeNull();
    expect(dto.chronotype.msfMinutes).toBeNull();
  });
});
