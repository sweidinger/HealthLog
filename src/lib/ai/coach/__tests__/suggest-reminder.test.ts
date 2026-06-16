import { describe, it, expect } from "vitest";

import {
  parseSuggestReminder,
  isCadenceId,
  CADENCE_CATALOG,
} from "@/lib/ai/coach/suggest-reminder";

describe("parseSuggestReminder", () => {
  it("returns the prose unchanged when no sentinel is present", () => {
    const r = parseSuggestReminder("Just a normal reply.");
    expect(r.prose).toBe("Just a normal reply.");
    expect(r.cadence).toBeNull();
    expect(r.malformed).toBe(false);
  });

  it("strips the block and resolves a valid cadence id", () => {
    const raw =
      "Maybe take a proper week of readings.\n" +
      "---SUGGEST-REMINDER---\n" +
      "cadence: bp_7_2_2\n" +
      "---END---";
    const r = parseSuggestReminder(raw);
    expect(r.prose).toBe("Maybe take a proper week of readings.");
    expect(r.cadence?.id).toBe("bp_7_2_2");
    expect(r.malformed).toBe(false);
  });

  it("keeps prose written AFTER the block (text-before + text-after)", () => {
    const raw =
      "Before the block.\n" +
      "---SUGGEST-REMINDER---\ncadence: bp_7_2_2\n---END---\n" +
      "And a closing thought after it.";
    const r = parseSuggestReminder(raw);
    expect(r.cadence?.id).toBe("bp_7_2_2");
    expect(r.prose).toContain("Before the block.");
    expect(r.prose).toContain("And a closing thought after it.");
    expect(r.prose).not.toContain("SUGGEST-REMINDER");
  });

  it("keeps trailing prose even on a malformed block", () => {
    const raw =
      "Before.\n---SUGGEST-REMINDER---\ncadence: bp_hourly\n---END---\nAfter.";
    const r = parseSuggestReminder(raw);
    expect(r.malformed).toBe(true);
    expect(r.prose).toContain("Before.");
    expect(r.prose).toContain("After.");
    expect(r.prose).not.toContain("SUGGEST-REMINDER");
  });

  it("strips quotes/backticks the model may add around the id", () => {
    const raw =
      "text\n---SUGGEST-REMINDER---\ncadence: `weight_daily`\n---END---";
    expect(parseSuggestReminder(raw).cadence?.id).toBe("weight_daily");
  });

  it("ignores informational reason lines", () => {
    const raw =
      "text\n---SUGGEST-REMINDER---\nreason: bp erratic\ncadence: bp_7_2_2\n---END---";
    expect(parseSuggestReminder(raw).cadence?.id).toBe("bp_7_2_2");
  });

  it("flags malformed and strips the block on an unknown cadence id", () => {
    const raw =
      "text\n---SUGGEST-REMINDER---\ncadence: bp_hourly\n---END---";
    const r = parseSuggestReminder(raw);
    expect(r.cadence).toBeNull();
    expect(r.malformed).toBe(true);
    // The raw marker must never leak into the prose shown to the user.
    expect(r.prose).not.toContain("SUGGEST-REMINDER");
    expect(r.prose).toBe("text");
  });

  it("tolerates a missing close marker (caps + still parses)", () => {
    const raw = "text\n---SUGGEST-REMINDER---\ncadence: weight_daily\n";
    expect(parseSuggestReminder(raw).cadence?.id).toBe("weight_daily");
  });

  it("caps an oversized payload before parsing", () => {
    const raw =
      "text\n---SUGGEST-REMINDER---\n" +
      "x".repeat(2000) +
      "\ncadence: weight_daily\n---END---";
    // The cadence line sits past the 512-byte cap → not found → malformed.
    const r = parseSuggestReminder(raw);
    expect(r.cadence).toBeNull();
    expect(r.malformed).toBe(true);
  });
});

describe("CADENCE_CATALOG", () => {
  it("isCadenceId only accepts catalog tokens", () => {
    expect(isCadenceId("bp_7_2_2")).toBe(true);
    expect(isCadenceId("weight_daily")).toBe(true);
    expect(isCadenceId("hrv_daily")).toBe(false);
    expect(isCadenceId("__proto__")).toBe(false);
  });

  it("every preset sets exactly one of intervalDays / rrule", () => {
    for (const c of Object.values(CADENCE_CATALOG)) {
      const hasInterval = c.intervalDays != null;
      const hasRrule = c.rrule != null;
      expect(hasInterval !== hasRrule).toBe(true);
    }
  });

  it("the BP protocol is finite (course-windowed) and the others open-ended", () => {
    expect(CADENCE_CATALOG.bp_7_2_2.courseDays).toBe(7);
    expect(CADENCE_CATALOG.weight_daily.courseDays).toBeNull();
    expect(CADENCE_CATALOG.glucose_structured.courseDays).toBeNull();
  });

  it("does not include passive RHR/HRV cadences", () => {
    const types = Object.values(CADENCE_CATALOG).map((c) => c.measurementType);
    expect(types).not.toContain("RESTING_HEART_RATE");
    expect(types).not.toContain("HEART_RATE_VARIABILITY");
  });
});
