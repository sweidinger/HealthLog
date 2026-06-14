/**
 * v1.15.0 — calendar composition over the deterministic engine.
 */
import { describe, it, expect } from "vitest";

import { buildCalendar, type CalendarDayLogRow } from "../engine-adapter";
import type { CycleProfile, MenstrualCycle } from "@/generated/prisma/client";

function profile(overrides: Partial<CycleProfile> = {}): CycleProfile {
  return {
    id: "p1",
    userId: "u1",
    goal: "GENERAL_HEALTH",
    cycleTrackingEnabled: true,
    typicalCycleLength: null,
    typicalPeriodLength: null,
    lutealPhaseLength: null,
    predictionEnabled: true,
    rawChartMode: false,
    discreetNotifications: false,
    sensitiveCategoryEncryption: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CycleProfile;
}

function cycle(startDate: string, overrides: Partial<MenstrualCycle> = {}): MenstrualCycle {
  return {
    id: `c-${startDate}`,
    userId: "u1",
    startDate,
    endDate: null,
    periodEndDate: null,
    lengthDays: null,
    ovulationDate: null,
    ovulationConfirmed: false,
    isPredicted: false,
    tz: null,
    syncVersion: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MenstrualCycle;
}

describe("buildCalendar", () => {
  // Three ~28-day cycles → a real prediction.
  const cycles = [
    cycle("2026-01-01", { endDate: "2026-01-28", lengthDays: 28, periodEndDate: "2026-01-05" }),
    cycle("2026-01-29", { endDate: "2026-02-25", lengthDays: 28, periodEndDate: "2026-02-02" }),
    cycle("2026-02-26", { periodEndDate: "2026-03-02" }),
  ];

  it("labels logged-flow days and emits a forecast for ≥2 cycles", () => {
    const dayLogs: CalendarDayLogRow[] = [
      { date: "2026-02-26", flow: "MEDIUM", basalBodyTempC: null, temperatureExcluded: false, ovulationTest: null, cervicalMucus: null, cervixPosition: null, cervixFirmness: null, cervixOpening: null, hasSymptoms: true },
    ];
    const { prediction, days } = buildCalendar(
      profile(),
      cycles,
      dayLogs,
      [],
      "2026-02-20",
      "2026-04-15",
      "2026-03-10",
      false,
    );
    expect(prediction).not.toBeNull();
    expect(prediction!.cyclesObserved).toBeGreaterThanOrEqual(2);

    const logged = days.find((d) => d.date === "2026-02-26")!;
    expect(logged.isPeriodLogged).toBe(true);
    expect(logged.flow).toBe("MEDIUM");
    expect(logged.hasSymptoms).toBe(true);

    // The forecast next-period start falls inside a predicted-period day.
    const predStart = prediction!.nextPeriodStart;
    const predDay = days.find((d) => d.date === predStart);
    expect(predDay?.isPredictedPeriod).toBe(true);
  });

  it("suppresses the fertile window at the grid when the goal disallows it", () => {
    const { days } = buildCalendar(
      profile({ goal: "GENERAL_HEALTH" }),
      cycles,
      [],
      [],
      "2026-02-20",
      "2026-04-15",
      "2026-03-10",
      false,
    );
    expect(days.every((d) => !d.isFertileWindow)).toBe(true);
    expect(days.every((d) => !d.isPredictedOvulation)).toBe(true);
  });

  it("surfaces the fertile window for the conception goal once past cold start", () => {
    // Four starts → three completed cycles → not still-learning.
    const fourCycles = [
      cycle("2026-01-01", { endDate: "2026-01-29", periodEndDate: "2026-01-05" }),
      cycle("2026-01-29", { endDate: "2026-02-26", periodEndDate: "2026-02-02" }),
      cycle("2026-02-26", { endDate: "2026-03-26", periodEndDate: "2026-03-02" }),
      cycle("2026-03-26", { periodEndDate: "2026-03-30" }),
    ];
    const { days } = buildCalendar(
      profile({ goal: "TRYING_TO_CONCEIVE" }),
      fourCycles,
      [],
      [],
      "2026-03-20",
      "2026-05-15",
      "2026-04-10",
      true,
    );
    expect(days.some((d) => d.isFertileWindow)).toBe(true);
  });

  it("emits no prediction in raw-chart mode", () => {
    const { prediction } = buildCalendar(
      profile({ rawChartMode: true }),
      cycles,
      [],
      [],
      "2026-02-20",
      "2026-04-15",
      "2026-03-10",
      false,
    );
    expect(prediction).toBeNull();
  });

  describe("still-learning gate (cold start)", () => {
    // One logged period — zero completed cycles → priors-only forecast.
    const oneCycle = [cycle("2026-02-26", { periodEndDate: "2026-03-02" })];

    it("flags stillLearning and asserts no fertile/ovulation grid for ≤1 cycle (TTC)", () => {
      const { prediction, stillLearning, days } = buildCalendar(
        profile({ goal: "TRYING_TO_CONCEIVE" }),
        oneCycle,
        [],
        [],
        "2026-02-20",
        "2026-04-15",
        "2026-03-10",
        true, // goal allows fertile — only the learning gate must suppress it
      );
      expect(prediction).not.toBeNull();
      expect(prediction!.cyclesObserved).toBeLessThan(3);
      expect(prediction!.stillLearning).toBe(true);
      expect(stillLearning).toBe(true);

      // No confident fertile shading or ovulation dot from a population guess.
      expect(days.every((d) => !d.isFertileWindow)).toBe(true);
      expect(days.every((d) => !d.isPredictedOvulation)).toBe(true);
      // No asserted phase band either (population-28 frame is not yet earned).
      expect(days.every((d) => d.phase === null)).toBe(true);
      // The predicted next-period bar still shows (the panel shows it too).
      expect(days.some((d) => d.isPredictedPeriod)).toBe(true);
    });

    it("emits normal fertile/ovulation/phase output once ≥3 cycles are observed", () => {
      // Four ~28-day starts → three COMPLETED cycle lengths → cyclesObserved=3.
      const fourCycles = [
        cycle("2026-01-01", { endDate: "2026-01-29", periodEndDate: "2026-01-05" }),
        cycle("2026-01-29", { endDate: "2026-02-26", periodEndDate: "2026-02-02" }),
        cycle("2026-02-26", { endDate: "2026-03-26", periodEndDate: "2026-03-02" }),
        cycle("2026-03-26", { periodEndDate: "2026-03-30" }),
      ];
      const { prediction, stillLearning, days } = buildCalendar(
        profile({ goal: "TRYING_TO_CONCEIVE" }),
        fourCycles,
        [],
        [],
        "2026-03-20",
        "2026-05-15",
        "2026-04-10",
        true,
      );
      expect(prediction!.cyclesObserved).toBeGreaterThanOrEqual(3);
      expect(prediction!.stillLearning).toBe(false);
      expect(stillLearning).toBe(false);
      expect(days.some((d) => d.isFertileWindow)).toBe(true);
      expect(days.some((d) => d.isPredictedOvulation)).toBe(true);
      expect(days.some((d) => d.phase !== null)).toBe(true);
    });
  });
});
