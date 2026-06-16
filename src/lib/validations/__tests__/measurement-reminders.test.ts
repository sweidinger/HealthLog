/**
 * v1.18.1 (V3) — the Vorsorge measurement-type allow-list. Widened from
 * the original 7 to the ~15 active-measurement set (vitals + the
 * body-composition family). App-layer only — the DB column is the full
 * MeasurementType enum, so this is the gate, not a migration.
 */
import { describe, expect, it } from "vitest";

import {
  measurementReminderTypeEnum,
  createMeasurementReminderSchema,
} from "../measurement-reminders";

describe("measurementReminderTypeEnum (V3 — completeness)", () => {
  const allowed = measurementReminderTypeEnum.options;

  it("exposes the full active set: vitals + body composition", () => {
    expect(new Set(allowed)).toEqual(
      new Set([
        // Vitals
        "WEIGHT",
        "BLOOD_PRESSURE_SYS",
        "PULSE",
        "BLOOD_GLUCOSE",
        "OXYGEN_SATURATION",
        "BODY_TEMPERATURE",
        // Body composition
        "BODY_FAT",
        "FAT_MASS",
        "FAT_FREE_MASS",
        "MUSCLE_MASS",
        "LEAN_BODY_MASS",
        "BONE_MASS",
        "TOTAL_BODY_WATER",
        "VISCERAL_FAT",
        "BODY_MASS_INDEX",
      ]),
    );
  });

  it("accepts a newly-added body-composition type on create", () => {
    const parsed = createMeasurementReminderSchema.safeParse({
      label: "Körperzusammensetzung messen",
      measurementType: "MUSCLE_MASS",
      intervalDays: 7,
    });
    expect(parsed.success).toBe(true);
  });

  it("matches BP on the SYS sentinel only (DIA would double-count)", () => {
    expect(allowed).toContain("BLOOD_PRESSURE_SYS");
    expect(allowed).not.toContain("BLOOD_PRESSURE_DIA");
  });

  it("deliberately excludes passive / cumulative / event types", () => {
    for (const excluded of [
      "RESTING_HEART_RATE",
      "HEART_RATE_VARIABILITY",
      "VO2_MAX",
      "ACTIVITY_STEPS",
      "RECOVERY_SCORE",
      "SLEEP_DURATION",
      "IRREGULAR_RHYTHM_NOTIFICATION",
    ]) {
      expect(allowed).not.toContain(excluded);
    }
  });

  it("still accepts a free-text reminder (null type) resolving on satisfy / lab", () => {
    const parsed = createMeasurementReminderSchema.safeParse({
      label: "Großes Blutbild",
      measurementType: null,
      rrule: "FREQ=YEARLY",
    });
    expect(parsed.success).toBe(true);
  });
});
