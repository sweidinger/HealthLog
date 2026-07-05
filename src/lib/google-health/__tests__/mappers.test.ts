/**
 * Documented-payload tests for the Google Health data-point mappers.
 *
 * Fixtures follow the official v4 response shapes: the DataPoint value is a
 * camelCase union keyed by the camelCase type name (`bodyFat`,
 * `dailyRestingHeartRate`, …) with camelCase nested times
 * (`sampleTime.physicalTime`, `interval.startTime`), proto3 int64 fields arrive
 * as JSON strings (`"8500"`), daily-summary `date` fields are `{year,month,day}`
 * objects, and the cumulative activity totals come from `:dailyRollUp`
 * aggregate windows (`civilStartTime.date` + `*Sum` fields). The tests pin the
 * MeasurementType, unit, value (incl. gram/millimetre conversions), the
 * resolved `measuredAt`, and the externalId `fieldTag` grain (spot anchor vs
 * the `stats:`-style daily-total overwrite key vs per-sleep-stage).
 */
import { describe, expect, it } from "vitest";

import {
  chunkCivilRange,
  formatCivilBound,
  incrementalFilter,
  GOOGLE_HEALTH_DATA_TYPES,
  mapActiveEnergy,
  mapBodyFat,
  mapDistance,
  mapFloors,
  mapGoogleHealthSleepStage,
  mapGoogleHealthSportType,
  mapHeartRate,
  mapHeartRateVariability,
  mapHeight,
  mapOxygenSaturation,
  mapRespiratoryRate,
  mapRestingHeartRate,
  mapSleepSession,
  mapSteps,
  mapVo2Max,
  mapWeight,
  mapWorkout,
} from "../client";

describe("mapWeight — spot sample", () => {
  it("maps a weightGrams sample to a WEIGHT reading in kg anchored on its physical time", () => {
    const rows = mapWeight({
      weight: {
        weightGrams: 72530,
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
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
    expect(mapWeight({ weight: { sampleTime: {} } })).toEqual([]);
  });
});

describe("mapBodyFat — camelCase union key", () => {
  it("reads the percentage under the camelCase bodyFat key", () => {
    const rows = mapBodyFat({
      bodyFat: {
        percentage: 21.7,
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "BODY_FAT",
      unit: "%",
      value: 21.7,
      fieldTag: "2026-06-01T08:00:00.000Z:body_fat",
    });
  });
});

describe("mapOxygenSaturation — daily-oxygen-saturation summary", () => {
  it("maps averagePercentage anchored on the {year,month,day} civil date", () => {
    const rows = mapOxygenSaturation({
      dailyOxygenSaturation: {
        averagePercentage: 97.4,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("OXYGEN_SATURATION");
    expect(r.unit).toBe("%");
    expect(r.value).toBe(97.4);
    // Civil-date summaries anchor at UTC midday (tz-shift-proof) and key per-day.
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    expect(r.fieldTag).toBe("2026-06-01:spo2");
  });
});

describe("mapHeartRateVariability — daily-heart-rate-variability summary", () => {
  it("maps averageHeartRateVariabilityMilliseconds to the HRV slot in ms", () => {
    const rows = mapHeartRateVariability({
      dailyHeartRateVariability: {
        averageHeartRateVariabilityMilliseconds: 42.5,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "HEART_RATE_VARIABILITY",
      unit: "ms",
      value: 42.5,
      fieldTag: "2026-06-01:hrv",
    });
  });
});

describe("mapRestingHeartRate — int64-string coercion", () => {
  it("coerces the beatsPerMinute int64 JSON string", () => {
    const rows = mapRestingHeartRate({
      dailyRestingHeartRate: {
        beatsPerMinute: "54",
        date: { year: 2026, month: 6, day: 1 },
      },
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

describe("mapRespiratoryRate — daily-respiratory-rate summary", () => {
  it("coerces the dailyRespiratoryRateBpm int64 JSON string", () => {
    const rows = mapRespiratoryRate({
      dailyRespiratoryRate: {
        dailyRespiratoryRateBpm: "14",
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      value: 14,
      fieldTag: "2026-06-01:resp_rate",
    });
  });
});

describe("mapHeartRate — intraday spot sample", () => {
  it("coerces the beatsPerMinute int64 JSON string and anchors on the instant", () => {
    const rows = mapHeartRate({
      heartRate: {
        beatsPerMinute: "62",
        sampleTime: { physicalTime: "2026-06-01T09:15:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "PULSE",
      unit: "bpm",
      value: 62,
      fieldTag: "2026-06-01T09:15:00.000Z:hr",
    });
  });
});

describe("mapHeight — profile seed", () => {
  it("converts heightMeters to cm and surfaces the sample instant", () => {
    const sample = mapHeight({
      height: {
        heightMeters: 1.82,
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(sample).not.toBeNull();
    expect(sample!.cm).toBe(182);
    expect(sample!.sampledAt?.toISOString()).toBe("2026-06-01T08:00:00.000Z");
  });

  it("returns null when no value parses", () => {
    expect(mapHeight({ height: {} })).toBeNull();
  });
});

describe("mapSteps — dailyRollUp aggregate window", () => {
  it("maps countSum (int64 string) keyed on civilStartTime.date", () => {
    const rows = mapSteps({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      civilEndTime: { date: { year: 2026, month: 6, day: 2 } },
      steps: { countSum: "8500" },
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
    // Anchored at UTC-midday so a tz shift can't roll the civil day.
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("drops a window with no parseable civil day (it cannot be keyed)", () => {
    expect(mapSteps({ steps: { countSum: "1200" } })).toEqual([]);
  });
});

describe("mapDistance — millimetre conversion", () => {
  it("converts millimetersSum (int64 string) to metres", () => {
    const rows = mapDistance({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      distance: { millimetersSum: "5200000" },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("WALKING_RUNNING_DISTANCE");
    expect(r.unit).toBe("m");
    expect(r.value).toBe(5200); // 5 200 000 mm → 5200 m
    expect(r.cumulativeDaily).toBe(true);
    expect(r.fieldTag).toBe("distance:2026-06-01");
  });
});

describe("mapActiveEnergy — preserves a legitimate zero", () => {
  it("keeps a rest-day 0 kcalSum (a real reading, not a gap)", () => {
    const rows = mapActiveEnergy({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      activeEnergyBurned: { kcalSum: 0 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      value: 0,
      cumulativeDaily: true,
      fieldTag: "active_energy:2026-06-01",
    });
  });
});

describe("mapFloors — dailyRollUp aggregate window", () => {
  it("maps countSum (int64 string) to FLIGHTS_CLIMBED", () => {
    const rows = mapFloors({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      floors: { countSum: "3" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "FLIGHTS_CLIMBED",
      unit: "flights",
      value: 3,
      cumulativeDaily: true,
      fieldTag: "floors:2026-06-01",
    });
  });
});

describe("mapVo2Max — daily-vo2-max summary", () => {
  it("maps vo2Max keyed per civil day (latest-wins overwrite grain)", () => {
    const rows = mapVo2Max({
      dailyVo2Max: {
        vo2Max: 41.2,
        estimated: true,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "VO2_MAX",
      unit: "mL/(kg·min)",
      value: 41.2,
      cumulativeDaily: true,
      fieldTag: "vo2_max:2026-06-01",
    });
  });

  it("drops a zero (VO2 max is strictly positive)", () => {
    expect(
      mapVo2Max({
        dailyVo2Max: { vo2Max: 0, date: { year: 2026, month: 6, day: 1 } },
      }),
    ).toEqual([]);
  });
});

describe("mapSleepSession — per-stage segments", () => {
  it("emits one SLEEP_DURATION row per known stage, skipping unknown labels", () => {
    const rows = mapSleepSession({
      sleep: {
        interval: {
          startTime: "2026-06-01T22:30:00.000Z",
          endTime: "2026-06-02T06:30:00.000Z",
        },
        type: "STAGES",
        stages: [
          {
            type: "DEEP",
            startTime: "2026-06-02T02:00:00.000Z",
            endTime: "2026-06-02T02:45:00.000Z",
          },
          {
            type: "REM",
            startTime: "2026-06-02T03:00:00.000Z",
            endTime: "2026-06-02T03:30:00.000Z",
          },
          {
            type: "SLEEP_STAGE_TYPE_UNSPECIFIED",
            startTime: "2026-06-02T04:00:00.000Z",
            endTime: "2026-06-02T04:10:00.000Z",
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
    // Per-stage rows key off the session END anchor + an indexed stage tag.
    expect(deep.fieldTag).toBe("2026-06-02T06:30:00.000Z:sleep_deep:0");

    const rem = rows[1]!;
    expect(rem.value).toBe(30);
    expect(rem.sleepStage).toBe("REM");
    expect(rem.fieldTag).toBe("2026-06-02T06:30:00.000Z:sleep_rem:1");
  });

  it("maps the documented SLEEP_STAGE_TYPE enum onto the shared bands", () => {
    expect(mapGoogleHealthSleepStage("LIGHT")).toBe("CORE"); // shallow-NREM band
    expect(mapGoogleHealthSleepStage("REM")).toBe("REM");
    expect(mapGoogleHealthSleepStage("RESTLESS")).toBe("AWAKE");
    expect(mapGoogleHealthSleepStage("ASLEEP")).toBe("ASLEEP");
    expect(
      mapGoogleHealthSleepStage("SLEEP_STAGE_TYPE_UNSPECIFIED"),
    ).toBeNull();
    expect(mapGoogleHealthSleepStage("nonsense")).toBeNull();
  });
});

describe("mapWorkout — exercise session", () => {
  it("maps a RUNNING session with metricsSummary fields and the top-level name id", () => {
    const w = mapWorkout({
      name: "users/me/dataTypes/exercise/dataPoints/abc123",
      exercise: {
        exerciseType: "RUNNING",
        interval: {
          startTime: "2026-06-03T07:00:00.000Z",
          endTime: "2026-06-03T07:45:00.000Z",
          civilStartTime: {
            date: { year: 2026, month: 6, day: 3 },
            time: { hours: 9 },
          },
        },
        metricsSummary: {
          caloriesKcal: 420,
          distanceMillimeters: 8000000,
          averageHeartRateBeatsPerMinute: "150",
          steps: "7600",
        },
      },
    });
    expect(w).not.toBeNull();
    expect(w).toMatchObject({
      externalId: "users/me/dataTypes/exercise/dataPoints/abc123",
      sportType: "running",
      durationSec: 2700, // 45 min
      totalEnergyKcal: 420,
      totalDistanceM: 8000, // 8 000 000 mm → 8000 m
      avgHeartRate: 150,
      // metricsSummary carries no max/min heart rate.
      maxHeartRate: null,
      minHeartRate: null,
    });
    expect(w!.startedAt.toISOString()).toBe("2026-06-03T07:00:00.000Z");
    expect(w!.endedAt.toISOString()).toBe("2026-06-03T07:45:00.000Z");
  });

  it("falls back to a start-anchored externalId when the resource name is absent", () => {
    const w = mapWorkout({
      exercise: {
        exerciseType: "WALKING",
        interval: {
          startTime: "2026-06-03T09:00:00.000Z",
          endTime: "2026-06-03T09:30:00.000Z",
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
            startTime: "2026-06-03T09:00:00.000Z",
            endTime: "2026-06-03T09:00:00.000Z", // zero-length
          },
        },
      }),
    ).toBeNull();
  });

  it("resolves the UPPERCASE ExerciseType enum, with a generic fallback", () => {
    expect(mapGoogleHealthSportType("STRENGTH_TRAINING")).toBe("strength");
    expect(mapGoogleHealthSportType("HIGH_INTENSITY_INTERVAL_TRAINING")).toBe(
      "hiit",
    );
    expect(mapGoogleHealthSportType("CYCLING")).toBe("cycling");
    expect(mapGoogleHealthSportType("KITESURFING")).toBe("other");
    expect(mapGoogleHealthSportType("")).toBe("other");
  });
});

describe("incrementalFilter — per-shape filter grammar", () => {
  const start = new Date("2026-06-01T15:30:00.000Z");

  it("filters samples on sample_time.physical_time (RFC-3339)", () => {
    expect(incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.weight, start)).toEqual({
      field: "weight.sample_time.physical_time",
      bound: "2026-06-01T15:30:00.000Z",
    });
  });

  it("filters daily summaries on .date (YYYY-MM-DD)", () => {
    expect(
      incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation, start),
    ).toEqual({
      field: "daily_oxygen_saturation.date",
      bound: "2026-06-01",
    });
  });

  it("filters sleep on interval.end_time — the only legal sleep time field", () => {
    expect(incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.sleep, start)).toEqual({
      field: "sleep.interval.end_time",
      bound: "2026-06-01T15:30:00.000Z",
    });
  });

  it("filters exercise on interval.civil_start_time with an offset-less civil bound in the user's zone", () => {
    expect(
      incrementalFilter(
        GOOGLE_HEALTH_DATA_TYPES.exercise,
        start,
        "Europe/Berlin",
      ),
    ).toEqual({
      field: "exercise.interval.civil_start_time",
      // 15:30Z = 17:30 Berlin wall clock (CEST) — no Z, no offset.
      bound: "2026-06-01T17:30:00",
    });
  });

  it("refuses to build a list filter for a rollup type", () => {
    expect(() =>
      incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.steps, start),
    ).toThrow(/dailyRollUp/);
  });
});

describe("formatCivilBound", () => {
  it("forms the bound in UTC when no zone is known", () => {
    expect(formatCivilBound(new Date("2026-06-01T15:30:45.000Z"))).toBe(
      "2026-06-01T15:30:45",
    );
  });
});

describe("chunkCivilRange — dailyRollUp 90-day slicing", () => {
  it("returns a single chunk for a range under the cap", () => {
    expect(
      chunkCivilRange(
        { year: 2026, month: 6, day: 1 },
        { year: 2026, month: 6, day: 8 },
      ),
    ).toEqual([
      {
        start: { year: 2026, month: 6, day: 1 },
        end: { year: 2026, month: 6, day: 8 },
      },
    ]);
  });

  it("slices a long range into closed-open ≤90-day chunks with no gap or overlap", () => {
    const chunks = chunkCivilRange(
      { year: 2026, month: 1, day: 1 },
      { year: 2026, month: 8, day: 1 },
    );
    expect(chunks.length).toBe(3); // 212 days → 90 + 90 + 32
    expect(chunks[0]!.start).toEqual({ year: 2026, month: 1, day: 1 });
    // Each chunk starts exactly where the previous one ends (closed-open).
    expect(chunks[1]!.start).toEqual(chunks[0]!.end);
    expect(chunks[2]!.start).toEqual(chunks[1]!.end);
    expect(chunks[2]!.end).toEqual({ year: 2026, month: 8, day: 1 });
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(
      chunkCivilRange(
        { year: 2026, month: 6, day: 8 },
        { year: 2026, month: 6, day: 1 },
      ),
    ).toEqual([]);
  });
});
