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

import {
  buildSleepRhythm,
  computeSleepRhythmFromNights,
  defaultDayType,
  type RhythmNight,
} from "../sleep-rhythm";

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
  it("tags weekend wake days free and weekdays work from the date key alone", () => {
    // 2026-06-13 is a Saturday, 2026-06-14 a Sunday, 2026-06-15 a Monday.
    expect(defaultDayType("2026-06-13")).toBe("free");
    expect(defaultDayType("2026-06-14")).toBe("free");
    expect(defaultDayType("2026-06-15")).toBe("work");
  });

  it("reads the weekday off the local date digits — correct for far-east zones", () => {
    // The wake-day key is already local; the weekday must not shift for a
    // UTC+14 user (the old noon-UTC anchor mislabelled a Friday as Saturday).
    expect(defaultDayType("2026-06-12")).toBe("work"); // Friday
    expect(defaultDayType("2026-06-13")).toBe("free"); // Saturday
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

describe("computeSleepRhythmFromNights window cap", () => {
  /** Build N trailing nights ending 2026-06-30, midpoint 04:00, asleep 420. */
  function trailingNights(count: number): RhythmNight[] {
    const out: RhythmNight[] = [];
    const end = Date.UTC(2026, 5, 30); // 2026-06-30
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(end - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      out.push({ night: key, asleepMinutes: 420, midpoint: 4 * 60 });
    }
    return out;
  }

  it("yields the same chronotype DTO whether fed 42 or 365 nights (source-window-independent)", () => {
    const need = 420;
    const sixWeeks = computeSleepRhythmFromNights(trailingNights(42), need);
    const oneYear = computeSleepRhythmFromNights(trailingNights(365), need);
    // The most-recent 42 nights are identical in both inputs, so the chronotype
    // (which the helper caps to the trailing window) must match exactly. This
    // is the invariant the dashboard summary (365-day read) + the /api/sleep/
    // rhythm route (42-day read) both depend on to render identical values.
    expect(oneYear.chronotype).toEqual(sixWeeks.chronotype);
  });
});
