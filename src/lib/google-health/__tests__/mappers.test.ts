/**
 * Representative-payload tests for the Google Health data-point mappers.
 *
 * The Google value-field JSON is undocumented, so each mapper hands a small set
 * of candidate shapes; these tests pin the launch-metric happy paths — the
 * MeasurementType, unit, value (incl. km→m conversion), the resolved
 * `measuredAt` timestamp/timezone, and the externalId `fieldTag` grain (spot
 * anchor vs the `stats:`-style daily-total overwrite key vs per-sleep-stage).
 */
import { describe, expect, it } from "vitest";

import {
  mapActiveEnergy,
  mapDistance,
  mapGoogleHealthSleepStage,
  mapGoogleHealthSportType,
  mapOxygenSaturation,
  mapRestingHeartRate,
  mapSleepSession,
  mapSteps,
  mapWeight,
  mapWorkout,
} from "../client";

describe("mapWeight — spot sample", () => {
  it("maps a kilograms sample to a WEIGHT reading anchored on its physical time", () => {
    const rows = mapWeight({
      weight: {
        kilograms: 72.53,
        sample_time: { physical_time: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("WEIGHT");
    expect(r.unit).toBe("kg");
    expect(r.value).toBe(72.53);
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T08:00:00.000Z");
    // Spot readings anchor on the instant → first-write-wins immutable externalId.
    expect(r.fieldTag).toBe("2026-06-01T08:00:00.000Z:weight");
    expect(r.cumulativeDaily).toBeUndefined();
  });

  it("returns nothing when no value parses", () => {
    expect(mapWeight({ weight: { sample_time: {} } })).toEqual([]);
  });
});

describe("mapOxygenSaturation — daily civil-date summary", () => {
  it("maps a nightly average to a percentage anchored on the civil day", () => {
    const rows = mapOxygenSaturation({
      oxygen_saturation: { average_percentage: 97.4, date: "2026-06-01" },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("OXYGEN_SATURATION");
    expect(r.unit).toBe("%");
    expect(r.value).toBe(97.4);
    // A civil-date summary anchors at UTC midnight and keys per-day.
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(r.fieldTag).toBe("2026-06-01:spo2");
  });
});

describe("mapRestingHeartRate", () => {
  it("maps beats_per_minute to a RESTING_HEART_RATE reading in bpm", () => {
    const rows = mapRestingHeartRate({
      daily_resting_heart_rate: { beats_per_minute: 54, date: "2026-06-01" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "RESTING_HEART_RATE",
      unit: "bpm",
      value: 54,
      fieldTag: "2026-06-01:rhr",
    });
  });
});

describe("mapSteps — daily cumulative total", () => {
  it("maps an interval daily total to a cumulative ACTIVITY_STEPS row", () => {
    const rows = mapSteps({
      steps: {
        count: 8500,
        interval: {
          start_time: "2026-06-01T00:00:00.000Z",
          end_time: "2026-06-01T23:59:59.000Z",
        },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("ACTIVITY_STEPS");
    expect(r.unit).toBe("steps");
    expect(r.value).toBe(8500);
    // Daily totals carry the overwrite-in-place grain (cumulativeDaily flag +
    // per-day fieldTag) so a re-fetched day replaces rather than duplicates.
    expect(r.cumulativeDaily).toBe(true);
    expect(r.fieldTag).toBe("steps:2026-06-01");
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("mapSteps — civil-day keying for a non-UTC-midnight interval", () => {
  it("keys the day + measuredAt on the CIVIL day, not the physical start instant", () => {
    const rows = mapSteps({
      steps: {
        count: 12000,
        interval: {
          // Physical instant is 15:00Z on 2026-06-01, but the civil day the
          // total belongs to is 2026-06-02 (a positive-UTC-offset user's local
          // midnight). The day-key must follow civil_start_time so Google/Apple/
          // Fitbit `stats:<tag>:<YYYY-MM-DD>` keys agree — start_time alone would
          // off-by-one the day.
          start_time: "2026-06-01T15:00:00.000Z",
          civil_start_time: "2026-06-02",
        },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("ACTIVITY_STEPS");
    expect(r.value).toBe(12000);
    expect(r.cumulativeDaily).toBe(true);
    // Day-key follows the civil day, not the 2026-06-01 physical instant.
    expect(r.fieldTag).toBe("steps:2026-06-02");
    // Anchored at UTC-midday so a tz shift can't roll the civil day.
    expect(r.measuredAt.toISOString()).toBe("2026-06-02T12:00:00.000Z");
  });
});

describe("mapDistance — unit conversion", () => {
  it("converts a kilometers daily total to metres", () => {
    const rows = mapDistance({
      distance: {
        kilometers: 5.2,
        interval: { start_time: "2026-06-01T00:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("WALKING_RUNNING_DISTANCE");
    expect(r.unit).toBe("m");
    expect(r.value).toBe(5200); // 5.2 km → 5200 m
    expect(r.cumulativeDaily).toBe(true);
  });

  it("prefers an explicit metres field when present", () => {
    const rows = mapDistance({
      distance: {
        meters: 8000,
        interval: { start_time: "2026-06-01T00:00:00.000Z" },
      },
    });
    expect(rows[0]!.value).toBe(8000);
  });
});

describe("mapActiveEnergy — preserves a legitimate zero", () => {
  it("keeps a rest-day 0 kcal (a real reading, not a gap)", () => {
    const rows = mapActiveEnergy({
      active_energy_burned: {
        active_kilocalories: 0,
        interval: { start_time: "2026-06-01T00:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      value: 0,
      cumulativeDaily: true,
    });
  });
});

describe("mapSleepSession — per-stage segments", () => {
  it("emits one SLEEP_DURATION row per known stage, skipping unknown labels", () => {
    const rows = mapSleepSession({
      sleep: {
        interval: { end_time: "2026-06-02T06:30:00.000Z" },
        stages: [
          {
            stage: "deep",
            start_time: "2026-06-02T02:00:00.000Z",
            end_time: "2026-06-02T02:45:00.000Z",
          },
          {
            stage: "rem",
            start_time: "2026-06-02T03:00:00.000Z",
            end_time: "2026-06-02T03:30:00.000Z",
          },
          {
            stage: "totally_unknown_label",
            start_time: "2026-06-02T04:00:00.000Z",
            end_time: "2026-06-02T04:10:00.000Z",
          },
        ],
      },
    });
    expect(rows).toHaveLength(2);

    const deep = rows[0]!;
    expect(deep.type).toBe("SLEEP_DURATION");
    expect(deep.unit).toBe("minutes");
    expect(deep.value).toBe(45);
    expect(deep.sleepStage).toBe("DEEP");
    expect(deep.measuredAt.toISOString()).toBe("2026-06-02T02:45:00.000Z");
    // Per-stage rows key off the session anchor + an indexed stage tag.
    expect(deep.fieldTag).toBe("2026-06-02T06:30:00.000Z:sleep_deep:0");

    const rem = rows[1]!;
    expect(rem.value).toBe(30);
    expect(rem.sleepStage).toBe("REM");
    expect(rem.fieldTag).toBe("2026-06-02T06:30:00.000Z:sleep_rem:1");
  });

  it("maps a 'light' stage onto the shared CORE band", () => {
    expect(mapGoogleHealthSleepStage("light")).toBe("CORE");
    expect(mapGoogleHealthSleepStage("REM")).toBe("REM");
    expect(mapGoogleHealthSleepStage("in-bed")).toBe("IN_BED");
    expect(mapGoogleHealthSleepStage("nonsense")).toBeNull();
  });
});

describe("mapWorkout — exercise session", () => {
  it("maps a running session to a Workout with duration, energy, distance and HR", () => {
    const w = mapWorkout({
      exercise: {
        activity_type: "running",
        session_id: "abc123",
        interval: {
          start_time: "2026-06-03T07:00:00.000Z",
          end_time: "2026-06-03T07:45:00.000Z",
        },
        active_kilocalories: 420,
        distance: { meters: 8000 },
        average_heart_rate: { beats_per_minute: 150 },
        maximum_heart_rate: { beats_per_minute: 172 },
      },
    });
    expect(w).not.toBeNull();
    expect(w).toMatchObject({
      externalId: "abc123",
      sportType: "running",
      durationSec: 2700, // 45 min
      totalEnergyKcal: 420,
      totalDistanceM: 8000,
      avgHeartRate: 150,
      maxHeartRate: 172,
      minHeartRate: null,
    });
    expect(w!.startedAt.toISOString()).toBe("2026-06-03T07:00:00.000Z");
    expect(w!.endedAt.toISOString()).toBe("2026-06-03T07:45:00.000Z");
  });

  it("falls back to a start-anchored externalId when no session id is present", () => {
    const w = mapWorkout({
      exercise: {
        type: "walk",
        interval: {
          start_time: "2026-06-03T09:00:00.000Z",
          end_time: "2026-06-03T09:30:00.000Z",
        },
      },
    });
    expect(w!.externalId).toBe("exercise:2026-06-03T09:00:00.000Z");
    expect(w!.sportType).toBe("walking");
  });

  it("returns null for a session with no usable time span", () => {
    expect(mapWorkout({ exercise: {} })).toBeNull();
    expect(
      mapWorkout({
        exercise: {
          interval: {
            start_time: "2026-06-03T09:00:00.000Z",
            end_time: "2026-06-03T09:00:00.000Z", // zero-length
          },
        },
      }),
    ).toBeNull();
  });

  it("resolves unknown sport types to a generic label", () => {
    expect(mapGoogleHealthSportType("kitesurfing")).toBe("other");
    expect(mapGoogleHealthSportType("")).toBe("other");
    expect(mapGoogleHealthSportType("Cycling")).toBe("cycling");
  });
});
