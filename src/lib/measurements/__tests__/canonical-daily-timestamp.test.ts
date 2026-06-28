import { describe, it, expect } from "vitest";

import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { userDayKey } from "@/lib/tz/format";

/**
 * Wearable daily-record anchoring (H-TZ1 / H-TZ2). Day-grained (date-only)
 * daily records from Oura / Polar / Fitbit must anchor at NOON, not UTC
 * midnight: a UTC-midnight anchor (`${day}T00:00:00.000Z`) double-shifts the
 * calendar day for west-of-UTC users on read, because the read path
 * re-buckets via `userDayKey(measuredAt, userTz)`. A noon anchor sits a full
 * 12 h inside the day, so it round-trips back to the same calendar day for
 * every IANA zone within ±12 h of UTC.
 *
 * These tests pin that invariant directly:
 *   userDayKey(canonicalDailyTimestamp(day, tz), tz) === day
 */
describe("canonicalDailyTimestamp — day round-trip across TZ offsets", () => {
  const days = [
    "2026-06-01",
    "2026-01-01",
    "2026-12-31",
    "2025-03-09", // US spring-forward
    "2025-11-02", // US fall-back
  ];

  const zones = [
    "UTC",
    "America/Los_Angeles", // negative offset (UTC-7/-8)
    "America/New_York", // negative offset (UTC-4/-5)
    "Asia/Tokyo", // positive offset (UTC+9, no DST)
    "Pacific/Kiritimati", // extreme positive (UTC+14)
    "Etc/GMT+12", // extreme negative (UTC-12)
    "Asia/Kathmandu", // sub-hour offset (UTC+5:45)
  ];

  for (const tz of zones) {
    for (const day of days) {
      it(`round-trips ${day} in ${tz}`, () => {
        const anchor = canonicalDailyTimestamp(day, tz);
        expect(userDayKey(anchor, tz)).toBe(day);
      });
    }
  }

  it("anchors at the user's local noon when a tz is given", () => {
    // 2026-06-01 noon in America/Los_Angeles (PDT, UTC-7) === 19:00 UTC.
    const anchor = canonicalDailyTimestamp("2026-06-01", "America/Los_Angeles");
    expect(anchor.toISOString()).toBe("2026-06-01T19:00:00.000Z");
  });
});

describe("canonicalDailyTimestamp — noon-UTC fallback (no tz)", () => {
  it("anchors at 12:00 UTC when tz is omitted", () => {
    const anchor = canonicalDailyTimestamp("2026-06-01");
    expect(anchor.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("the noon-UTC fallback round-trips for every zone within ±12 h", () => {
    // This is the shape the wearable mappers (Oura/Polar/Fitbit) take, since
    // they do not have the user's timezone in scope at map time.
    const day = "2026-06-01";
    const anchor = canonicalDailyTimestamp(day); // 12:00 UTC
    for (const tz of [
      "UTC",
      "America/Los_Angeles",
      "America/New_York",
      "Asia/Tokyo",
      "Australia/Sydney",
      "Etc/GMT+11",
      "Etc/GMT-11",
    ]) {
      expect(userDayKey(anchor, tz)).toBe(day);
    }
  });
});
