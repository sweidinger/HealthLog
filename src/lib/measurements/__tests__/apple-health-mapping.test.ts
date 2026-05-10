import { describe, expect, it } from "vitest";
import {
  APPLE_HEALTH_SLEEP_STAGE_MAP,
  APPLE_HEALTH_TYPE_MAP,
  mapAppleHealthEntry,
} from "../apple-health-mapping";
import { measurementTypeEnum } from "@/lib/validations/measurement";

describe("APPLE_HEALTH_TYPE_MAP", () => {
  it("only references measurement types that exist in the canonical enum", () => {
    const enumValues = new Set<string>(measurementTypeEnum.options);
    for (const mapping of Object.values(APPLE_HEALTH_TYPE_MAP)) {
      expect(
        enumValues.has(mapping.measurementType),
        `${mapping.hkIdentifier} → unknown MeasurementType ${mapping.measurementType}`,
      ).toBe(true);
    }
  });

  it("uses each mapping key as the canonical hkIdentifier", () => {
    for (const [key, mapping] of Object.entries(APPLE_HEALTH_TYPE_MAP)) {
      expect(mapping.hkIdentifier).toBe(key);
    }
  });

  it("flags the explicit-consent metrics as privacy sensitive", () => {
    const sensitive = Object.values(APPLE_HEALTH_TYPE_MAP)
      .filter((m) => m.isPrivacySensitive)
      .map((m) => m.hkIdentifier)
      .sort();
    expect(sensitive).toEqual(
      [
        "HKCategoryTypeIdentifierSleepAnalysis",
        "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        "HKQuantityTypeIdentifierVO2Max",
      ].sort(),
    );
  });

  it("converts oxygen saturation from 0..1 fraction to 0..100 percent", () => {
    const mapping = APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierOxygenSaturation;
    expect(mapping.convertToDbUnit(0.97)).toBeCloseTo(97);
  });

  it("converts body fat percentage from 0..1 fraction to 0..100 percent", () => {
    const mapping =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierBodyFatPercentage;
    expect(mapping.convertToDbUnit(0.245)).toBeCloseTo(24.5);
  });

  it("uses identity conversion for the SI-aligned identifiers", () => {
    for (const id of [
      "HKQuantityTypeIdentifierBodyMass",
      "HKQuantityTypeIdentifierBloodPressureSystolic",
      "HKQuantityTypeIdentifierBloodPressureDiastolic",
      "HKQuantityTypeIdentifierHeartRate",
      "HKQuantityTypeIdentifierRestingHeartRate",
      "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
      "HKQuantityTypeIdentifierStepCount",
      "HKQuantityTypeIdentifierActiveEnergyBurned",
      "HKQuantityTypeIdentifierFlightsClimbed",
      "HKQuantityTypeIdentifierDistanceWalkingRunning",
      "HKQuantityTypeIdentifierVO2Max",
      "HKQuantityTypeIdentifierBloodGlucose",
      "HKQuantityTypeIdentifierBodyTemperature",
    ]) {
      const mapping = APPLE_HEALTH_TYPE_MAP[id];
      expect(mapping.convertToDbUnit(42)).toBe(42);
    }
  });
});

describe("APPLE_HEALTH_SLEEP_STAGE_MAP", () => {
  it("maps the iOS 16+ stage codepoints to DB enum values", () => {
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[0]).toBe("IN_BED");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[1]).toBe("ASLEEP");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[2]).toBe("AWAKE");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[3]).toBe("CORE");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[4]).toBe("DEEP");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[5]).toBe("REM");
  });

  it("does not double-claim a codepoint for two stages", () => {
    const codepoints = Object.keys(APPLE_HEALTH_SLEEP_STAGE_MAP);
    expect(new Set(codepoints).size).toBe(codepoints.length);
  });
});

describe("mapAppleHealthEntry", () => {
  const ts = "2026-05-10T07:30:00.000Z";

  it("returns null for an unknown identifier", () => {
    expect(
      mapAppleHealthEntry({
        hkIdentifier: "HKQuantityTypeIdentifierHallucinated",
        value: 1,
        unit: "kg",
        startDate: ts,
        endDate: ts,
      }),
    ).toBeNull();
  });

  it("returns null for an invalid endDate", () => {
    expect(
      mapAppleHealthEntry({
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 80,
        unit: "kg",
        startDate: ts,
        endDate: "not-a-date",
      }),
    ).toBeNull();
  });

  it("anchors `takenAt` on the sample's endDate", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 81.5,
      unit: "kg",
      startDate: "2026-05-10T07:00:00.000Z",
      endDate: ts,
    });
    expect(out).not.toBeNull();
    expect(out!.takenAt.toISOString()).toBe(ts);
  });

  it("applies the unit conversion for fraction-shaped quantities", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierOxygenSaturation",
      value: 0.97,
      unit: "fraction",
      startDate: ts,
      endDate: ts,
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("OXYGEN_SATURATION");
    expect(out!.unit).toBe("%");
    expect(out!.value).toBeCloseTo(97);
    expect(out!.sleepStage).toBeUndefined();
  });

  it("yields a body weight row for a HKQuantityTypeIdentifierBodyMass sample", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 81.5,
      unit: "kg",
      startDate: ts,
      endDate: ts,
    });
    expect(out).toEqual({
      type: "WEIGHT",
      value: 81.5,
      unit: "kg",
      takenAt: new Date(ts),
    });
  });

  it("yields a per-stage sleep row for a sleepAnalysis sample", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 95, // minutes spent in this stage
      unit: "min",
      startDate: "2026-05-10T01:00:00.000Z",
      endDate: "2026-05-10T02:35:00.000Z",
      sleepStage: 4, // DEEP
    });
    expect(out).toEqual({
      type: "SLEEP_DURATION",
      value: 95,
      unit: "minutes",
      takenAt: new Date("2026-05-10T02:35:00.000Z"),
      sleepStage: "DEEP",
    });
  });

  it("returns null for a sleepAnalysis sample without a stage codepoint", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 60,
      unit: "min",
      startDate: ts,
      endDate: ts,
    });
    expect(out).toBeNull();
  });

  it("returns null for a sleepAnalysis sample with an unknown stage codepoint", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 60,
      unit: "min",
      startDate: ts,
      endDate: ts,
      sleepStage: 99,
    });
    expect(out).toBeNull();
  });
});
