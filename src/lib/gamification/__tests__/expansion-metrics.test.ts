import { describe, it, expect } from "vitest";
import {
  buildExpansionMetricValues,
  countMeasurementsByType,
  getEarnabilityFlags,
  getEngagementMetrics,
  getHiddenMetrics,
  getMoodMetrics,
} from "@/lib/gamification/expansion-metrics";

describe("countMeasurementsByType", () => {
  it("counts each type independently", () => {
    const result = countMeasurementsByType([
      { type: "WEIGHT", measuredAt: new Date("2026-04-01T08:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-02T08:00:00Z") },
      {
        type: "BLOOD_PRESSURE_SYS",
        measuredAt: new Date("2026-04-01T08:00:00Z"),
      },
      {
        type: "BLOOD_PRESSURE_DIA",
        measuredAt: new Date("2026-04-01T08:00:00Z"),
      },
      { type: "PULSE", measuredAt: new Date("2026-04-03T08:00:00Z") },
    ]);
    // BLOOD_PRESSURE_DIA is intentionally not counted — the canonical
    // BP entry is the SYS row so we don't double-count a single BP
    // reading that's stored as two rows.
    expect(result).toEqual({ weightCount: 2, bpCount: 1, pulseCount: 1 });
  });

  it("returns zeros for an empty input", () => {
    expect(countMeasurementsByType([])).toEqual({
      weightCount: 0,
      bpCount: 0,
      pulseCount: 0,
    });
  });
});

describe("getMoodMetrics", () => {
  it("returns zeros when there are no entries", () => {
    expect(getMoodMetrics([])).toEqual({
      moodEntryCount: 0,
      moodDayStreak: 0,
      moodImprovementHit: 0,
    });
  });

  it("computes count + longest day-streak", () => {
    const entries = [
      // 4 consecutive days then a gap then 2 more — longest = 4
      { date: "2026-04-01", score: 3, moodLoggedAt: new Date() },
      { date: "2026-04-02", score: 3, moodLoggedAt: new Date() },
      { date: "2026-04-03", score: 4, moodLoggedAt: new Date() },
      { date: "2026-04-04", score: 4, moodLoggedAt: new Date() },
      { date: "2026-04-10", score: 4, moodLoggedAt: new Date() },
      { date: "2026-04-11", score: 4, moodLoggedAt: new Date() },
    ];
    const m = getMoodMetrics(entries);
    expect(m.moodEntryCount).toBe(6);
    expect(m.moodDayStreak).toBe(4);
  });

  it("hits the improvement metric when the recent 7-day mean is +1.0 above the prior 7-day mean", () => {
    const entries = [];
    // Prior week: mean 2.0
    for (let i = 0; i < 7; i++) {
      entries.push({
        date: `2026-04-0${i + 1}`,
        score: 2,
        moodLoggedAt: new Date(),
      });
    }
    // Recent week: mean 3.5 — improvement of 1.5
    for (let i = 0; i < 7; i++) {
      const day = i + 8;
      entries.push({
        date: `2026-04-${String(day).padStart(2, "0")}`,
        score: i % 2 === 0 ? 3 : 4,
        moodLoggedAt: new Date(),
      });
    }
    const m = getMoodMetrics(entries);
    expect(m.moodImprovementHit).toBe(1);
  });

  it("does not hit the improvement metric when improvement is below 1.0", () => {
    const entries = [];
    for (let i = 0; i < 7; i++) {
      entries.push({
        date: `2026-04-0${i + 1}`,
        score: 3,
        moodLoggedAt: new Date(),
      });
    }
    for (let i = 0; i < 7; i++) {
      const day = i + 8;
      entries.push({
        date: `2026-04-${String(day).padStart(2, "0")}`,
        // Mean 3.5 → +0.5 only
        score: i % 2 === 0 ? 3 : 4,
        moodLoggedAt: new Date(),
      });
    }
    expect(getMoodMetrics(entries).moodImprovementHit).toBe(0);
  });
});

describe("getEngagementMetrics", () => {
  it("counts a consistent month with at least 25 distinct entry days", () => {
    const measurements = [];
    for (let day = 1; day <= 26; day++) {
      measurements.push({
        type: "WEIGHT",
        measuredAt: new Date(
          `2026-04-${String(day).padStart(2, "0")}T08:00:00Z`,
        ),
      });
    }
    const result = getEngagementMetrics({
      measurements,
      moodEntries: [],
      intakeEvents: [],
    });
    expect(result.consistentMonthCount).toBe(1);
  });

  it("does not count a month with only 24 distinct days as consistent", () => {
    const measurements = [];
    for (let day = 1; day <= 24; day++) {
      measurements.push({
        type: "WEIGHT",
        measuredAt: new Date(
          `2026-04-${String(day).padStart(2, "0")}T08:00:00Z`,
        ),
      });
    }
    const result = getEngagementMetrics({
      measurements,
      moodEntries: [],
      intakeEvents: [],
    });
    expect(result.consistentMonthCount).toBe(0);
  });

  it("computes the longest entry-day streak across measurement / mood / intake", () => {
    const result = getEngagementMetrics({
      measurements: [
        { type: "WEIGHT", measuredAt: new Date("2026-04-01T08:00:00Z") },
      ],
      moodEntries: [
        {
          date: "2026-04-02",
          score: 3,
          moodLoggedAt: new Date("2026-04-02T08:00:00Z"),
        },
        {
          date: "2026-04-03",
          score: 3,
          moodLoggedAt: new Date("2026-04-03T08:00:00Z"),
        },
      ],
      intakeEvents: [
        {
          scheduledFor: new Date("2026-04-04T08:00:00Z"),
          takenAt: new Date("2026-04-04T08:30:00Z"),
          skipped: false,
        },
      ],
    });
    // 4 consecutive days
    expect(result.entryDayStreak).toBe(4);
  });

  it("counts consecutive Sat+Sun pairs for the weekend warrior badge", () => {
    // Saturdays + Sundays April 4/5, 11/12, 18/19, 25/26 — 4 in a row
    const measurements = [
      { type: "WEIGHT", measuredAt: new Date("2026-04-04T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-05T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-11T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-12T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-18T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-19T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-25T12:00:00Z") },
      { type: "WEIGHT", measuredAt: new Date("2026-04-26T12:00:00Z") },
    ];
    const result = getEngagementMetrics({
      measurements,
      moodEntries: [],
      intakeEvents: [],
    });
    expect(result.weekendStreakCount).toBeGreaterThanOrEqual(4);
  });
});

describe("getHiddenMetrics", () => {
  it("counts night-owl entries between 02:00 and 04:00 Berlin", () => {
    const result = getHiddenMetrics({
      // 02:30 Berlin in summer = 00:30 UTC. Use UTC offsets that yield
      // the right Berlin hour. April is CEST (UTC+2), so 00:30Z = 02:30
      // Berlin → night owl.
      measurements: [
        { type: "WEIGHT", measuredAt: new Date("2026-04-15T00:30:00Z") },
      ],
      moodEntries: [],
      intakeEvents: [],
      auditEvents: [],
    });
    expect(result.nightOwlCount).toBe(1);
    expect(result.earlyBirdCount).toBe(0);
  });

  it("counts early-bird entries between 04:00 and 06:00 Berlin", () => {
    // 03:30 UTC = 05:30 Berlin in CEST → early-bird
    const result = getHiddenMetrics({
      measurements: [
        { type: "WEIGHT", measuredAt: new Date("2026-04-15T03:30:00Z") },
      ],
      moodEntries: [],
      intakeEvents: [],
      auditEvents: [],
    });
    expect(result.earlyBirdCount).toBe(1);
    expect(result.nightOwlCount).toBe(0);
  });

  it("counts February 29 entries on a leap year", () => {
    const result = getHiddenMetrics({
      measurements: [
        { type: "WEIGHT", measuredAt: new Date("2024-02-29T12:00:00Z") },
      ],
      moodEntries: [],
      intakeEvents: [],
      auditEvents: [],
    });
    expect(result.leapDayCount).toBe(1);
  });

  it("counts doctor-PDF exports and locale-flips from audit events", () => {
    const result = getHiddenMetrics({
      measurements: [],
      moodEntries: [],
      intakeEvents: [],
      auditEvents: [
        // The route's auditLog filter accepts both `generate` actions.
        { action: "doctor-report.generate", createdAt: new Date() },
        { action: "doctor-report.pdf.generate", createdAt: new Date() },
        { action: "settings.locale.update", createdAt: new Date() },
        { action: "auth.login.passkey", createdAt: new Date() }, // ignored
      ],
    });
    expect(result.doctorPdfCount).toBe(2);
    expect(result.localeFlipCount).toBe(1);
  });
});

describe("getEarnabilityFlags", () => {
  it("flags categories the user has data for", () => {
    expect(
      getEarnabilityFlags({
        hasMedication: true,
        moodEntryCount: 3,
        measurementCounts: { weightCount: 0, bpCount: 5, pulseCount: 0 },
      }),
    ).toEqual({
      hasMedication: true,
      hasMood: true,
      hasWeight: false,
      hasBp: true,
      hasPulse: false,
      hasSleep: false,
    });
  });

  it("flags sleep when at least one sleep sample exists (v1.16.1)", () => {
    expect(
      getEarnabilityFlags({
        hasMedication: false,
        moodEntryCount: 0,
        measurementCounts: { weightCount: 0, bpCount: 0, pulseCount: 0 },
        sleepSampleCount: 3,
      }).hasSleep,
    ).toBe(true);
  });
});

describe("buildExpansionMetricValues — integration smoke", () => {
  it("produces a fully-zeroed object for an empty user", () => {
    const result = buildExpansionMetricValues({
      measurements: [],
      moodEntries: [],
      intakeEvents: [],
      auditEvents: [],
    });
    for (const value of Object.values(result)) {
      expect(value).toBe(0);
    }
  });
});
