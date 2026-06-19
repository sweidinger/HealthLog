import { describe, expect, it } from "vitest";

import {
  mapHkCycleSample,
  isCycleHkIdentifier,
  hkSymptomIsPresent,
  HK_MENSTRUAL_FLOW,
  HK_INTERMENSTRUAL_BLEEDING,
  HK_CERVICAL_MUCUS,
  HK_OVULATION_TEST,
  HK_SEXUAL_ACTIVITY,
  HK_PREGNANCY_TEST,
  HK_PROGESTERONE_TEST,
  HK_CONTRACEPTIVE,
  HK_PREGNANCY,
  HK_LACTATION,
} from "../healthkit-mapping";

describe("cycle/healthkit-mapping — identifier ownership", () => {
  it("owns the promoted reproductive identifiers", () => {
    expect(isCycleHkIdentifier(HK_MENSTRUAL_FLOW)).toBe(true);
    expect(isCycleHkIdentifier(HK_OVULATION_TEST)).toBe(true);
    expect(isCycleHkIdentifier(HK_CONTRACEPTIVE)).toBe(true);
    expect(isCycleHkIdentifier("HKCategoryTypeIdentifierAbdominalCramps")).toBe(
      true,
    );
  });

  it("does NOT own pregnancy/lactation status (deferred — no schema target)", () => {
    expect(isCycleHkIdentifier(HK_PREGNANCY)).toBe(false);
    expect(isCycleHkIdentifier(HK_LACTATION)).toBe(false);
  });

  it("does NOT own unrelated identifiers", () => {
    expect(isCycleHkIdentifier("HKQuantityTypeIdentifierStepCount")).toBe(
      false,
    );
  });
});

describe("cycle/healthkit-mapping — menstrual flow", () => {
  it("maps the symbolic value names to FlowLevel", () => {
    expect(
      mapHkCycleSample(HK_MENSTRUAL_FLOW, "HKCategoryValueMenstrualFlowLight"),
    ).toEqual({ kind: "day-log", fields: { flow: "LIGHT" } });
    expect(
      mapHkCycleSample(HK_MENSTRUAL_FLOW, "HKCategoryValueMenstrualFlowHeavy"),
    ).toEqual({ kind: "day-log", fields: { flow: "HEAVY" } });
    expect(
      mapHkCycleSample(HK_MENSTRUAL_FLOW, "HKCategoryValueMenstrualFlowNone"),
    ).toEqual({ kind: "day-log", fields: { flow: "NONE" } });
  });

  it("maps the integer codepoints (live-API form)", () => {
    expect(mapHkCycleSample(HK_MENSTRUAL_FLOW, "2")).toEqual({
      kind: "day-log",
      fields: { flow: "LIGHT" },
    });
    expect(mapHkCycleSample(HK_MENSTRUAL_FLOW, "4")).toEqual({
      kind: "day-log",
      fields: { flow: "HEAVY" },
    });
  });

  it("maps HK unspecified → LIGHT (conservative boundary)", () => {
    expect(
      mapHkCycleSample(
        HK_MENSTRUAL_FLOW,
        "HKCategoryValueMenstrualFlowUnspecified",
      ),
    ).toEqual({ kind: "day-log", fields: { flow: "LIGHT" } });
  });

  it("skips an unrecognised flow value", () => {
    expect(mapHkCycleSample(HK_MENSTRUAL_FLOW, "garbage")).toEqual({
      kind: "skip",
    });
  });
});

describe("cycle/healthkit-mapping — ovulation + cervical mucus + tests", () => {
  it("maps ovulation results", () => {
    expect(
      mapHkCycleSample(
        HK_OVULATION_TEST,
        "HKCategoryValueOvulationTestResultLuteinizingHormoneSurge",
      ),
    ).toEqual({
      kind: "day-log",
      fields: { ovulationTest: "POSITIVE_LH_SURGE" },
    });
    expect(mapHkCycleSample(HK_OVULATION_TEST, "4")).toEqual({
      kind: "day-log",
      fields: { ovulationTest: "ESTROGEN_SURGE" },
    });
  });

  it("maps cervical mucus", () => {
    expect(
      mapHkCycleSample(
        HK_CERVICAL_MUCUS,
        "HKCategoryValueCervicalMucusQualityEggWhite",
      ),
    ).toEqual({ kind: "day-log", fields: { cervicalMucus: "EGG_WHITE" } });
  });

  it("maps pregnancy + progesterone test results", () => {
    expect(mapHkCycleSample(HK_PREGNANCY_TEST, "2")).toEqual({
      kind: "day-log",
      fields: { pregnancyTest: "POSITIVE" },
    });
    expect(mapHkCycleSample(HK_PROGESTERONE_TEST, "1")).toEqual({
      kind: "day-log",
      fields: { progesteroneTest: "NEGATIVE" },
    });
  });

  it("maps intermenstrual bleeding (presence)", () => {
    expect(mapHkCycleSample(HK_INTERMENSTRUAL_BLEEDING, undefined)).toEqual({
      kind: "day-log",
      fields: { intermenstrualBleeding: true },
    });
  });
});

describe("cycle/healthkit-mapping — sexual activity + protection", () => {
  it("records protectedSex from the protection metadata", () => {
    expect(mapHkCycleSample(HK_SEXUAL_ACTIVITY, undefined, true)).toEqual({
      kind: "day-log",
      fields: { sexualActivity: true, protectedSex: true },
    });
    expect(mapHkCycleSample(HK_SEXUAL_ACTIVITY, undefined, false)).toEqual({
      kind: "day-log",
      fields: { sexualActivity: true, protectedSex: false },
    });
  });

  it("leaves protectedSex null when the metadata is absent", () => {
    expect(mapHkCycleSample(HK_SEXUAL_ACTIVITY, undefined)).toEqual({
      kind: "day-log",
      fields: { sexualActivity: true, protectedSex: null },
    });
  });
});

describe("cycle/healthkit-mapping — contraceptive routes to day-log + profile", () => {
  it("records the method AND carries a profile nudge", () => {
    expect(
      mapHkCycleSample(HK_CONTRACEPTIVE, "HKCategoryValueContraceptiveOral"),
    ).toEqual({
      kind: "day-log+profile",
      fields: { contraceptive: "ORAL" },
      profile: { contraceptive: "ORAL" },
    });
  });
});

describe("cycle/healthkit-mapping — symptoms", () => {
  it("maps symptom identifiers to the seeded catalogue keys", () => {
    expect(
      mapHkCycleSample("HKCategoryTypeIdentifierAbdominalCramps", "3"),
    ).toEqual({ kind: "day-log", fields: { symptomKey: "cramps" } });
    expect(
      mapHkCycleSample("HKCategoryTypeIdentifierLowerBackPain", "4"),
    ).toEqual({ kind: "day-log", fields: { symptomKey: "back_pain" } });
  });

  it("skips an explicit not-present symptom sample", () => {
    expect(mapHkCycleSample("HKCategoryTypeIdentifierHeadache", "1")).toEqual({
      kind: "skip",
    });
    expect(hkSymptomIsPresent("1")).toBe(false);
    expect(hkSymptomIsPresent("HKCategoryValueSeverityNotPresent")).toBe(false);
    expect(hkSymptomIsPresent("3")).toBe(true);
  });
});
