/**
 * v1.15.18 — `normaliseDoseWindows` coerces the persisted `dose_windows` JSON
 * into a clean `DoseWindowEntry[]`, dropping anything malformed so the band
 * paths never have to defend against an arbitrary JSON shape.
 */
import { describe, expect, it } from "vitest";

import {
  buildCanonicalSchedule,
  normaliseDoseWindows,
  type WorkerScheduleRow,
} from "../worker-helpers";

describe("normaliseDoseWindows", () => {
  it("returns null for null / non-array input", () => {
    expect(normaliseDoseWindows(null)).toBeNull();
    expect(normaliseDoseWindows(undefined)).toBeNull();
    expect(normaliseDoseWindows("nope")).toBeNull();
    expect(normaliseDoseWindows({ timeOfDay: "07:00" })).toBeNull();
  });

  it("keeps a well-formed entry", () => {
    expect(
      normaliseDoseWindows([{ timeOfDay: "07:00", start: "07:00", end: "09:00" }]),
    ).toEqual([{ timeOfDay: "07:00", start: "07:00", end: "09:00" }]);
  });

  it("drops entries with start > end, bad HH:mm, or missing keys", () => {
    expect(
      normaliseDoseWindows([
        { timeOfDay: "07:00", start: "12:00", end: "07:00" }, // start > end
        { timeOfDay: "7:00", start: "07:00", end: "09:00" }, // bad HH:mm
        { timeOfDay: "19:00", start: "19:00" }, // missing end
        { timeOfDay: "08:00", start: "25:00", end: "26:00" }, // out of range
      ]),
    ).toBeNull();
  });

  it("keeps the good entries and drops the bad ones in a mixed array", () => {
    expect(
      normaliseDoseWindows([
        { timeOfDay: "07:00", start: "07:00", end: "09:00" }, // good
        { timeOfDay: "19:00", start: "20:00", end: "19:00" }, // start > end
      ]),
    ).toEqual([{ timeOfDay: "07:00", start: "07:00", end: "09:00" }]);
  });

  it("threads through buildCanonicalSchedule onto the canonical schedule", () => {
    const row: WorkerScheduleRow = {
      id: "s1",
      windowStart: "07:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["07:00"],
      reminderGraceMinutes: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      doseWindows: [{ timeOfDay: "07:00", start: "07:00", end: "09:00" }],
    };
    expect(buildCanonicalSchedule(row).doseWindows).toEqual([
      { timeOfDay: "07:00", start: "07:00", end: "09:00" },
    ]);
  });

  it("a row with no doseWindows yields null on the canonical schedule", () => {
    const row: WorkerScheduleRow = {
      id: "s1",
      windowStart: "07:00",
      windowEnd: "09:00",
      daysOfWeek: null,
      timesOfDay: ["07:00"],
      reminderGraceMinutes: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
    };
    expect(buildCanonicalSchedule(row).doseWindows).toBeNull();
  });
});
