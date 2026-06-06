import { describe, expect, it } from "vitest";

import { addDays, dayDiff, isOnOrBefore, isWithin, parseDayMs, roundHalf } from "../day-math";

/**
 * The day-math is the shared substrate iOS re-implements bit-for-bit. These
 * tests are written to be TIMEZONE-INDEPENDENT: every assertion is about the
 * noon-UTC anchored calendar difference, so the result is the same whether the
 * host runs under TZ=UTC, America/New_York, Pacific/Auckland, or across a DST
 * transition. No assertion anchors on a local calendar value.
 */
describe("cycle/day-math", () => {
  describe("parseDayMs", () => {
    it("anchors a date at noon UTC", () => {
      // 2024-03-10 is a US DST spring-forward day; the noon anchor is immune.
      expect(parseDayMs("2024-03-10")).toBe(Date.parse("2024-03-10T12:00:00Z"));
    });

    it("throws on a malformed date (fail-closed)", () => {
      expect(() => parseDayMs("2024-3-10")).toThrow();
      expect(() => parseDayMs("not-a-date")).toThrow();
      expect(() => parseDayMs("2024-13-01")).toThrow();
    });
  });

  describe("dayDiff", () => {
    it("counts whole days, sign follows a - b", () => {
      expect(dayDiff("2024-01-10", "2024-01-01")).toBe(9);
      expect(dayDiff("2024-01-01", "2024-01-10")).toBe(-9);
      expect(dayDiff("2024-01-01", "2024-01-01")).toBe(0);
    });

    it("is stable across a DST spring-forward boundary (no half-day drift)", () => {
      // US/EU clocks lose an hour around 2024-03-10 / 2024-03-31. The noon-UTC
      // anchor means a calendar week is still exactly 7 days, not 6 or 8.
      expect(dayDiff("2024-03-15", "2024-03-08")).toBe(7);
      expect(dayDiff("2024-03-31", "2024-03-10")).toBe(21);
    });

    it("is stable across a DST fall-back boundary", () => {
      expect(dayDiff("2024-11-10", "2024-11-03")).toBe(7);
    });

    it("counts a 28-day cycle exactly across a month boundary", () => {
      expect(dayDiff("2024-02-29", "2024-02-01")).toBe(28); // leap year
      expect(dayDiff("2023-03-01", "2023-02-01")).toBe(28); // non-leap Feb
    });

    it("spans a leap day correctly", () => {
      expect(dayDiff("2024-03-01", "2024-02-28")).toBe(2);
      expect(dayDiff("2023-03-01", "2023-02-28")).toBe(1);
    });
  });

  describe("addDays", () => {
    it("adds and subtracts across month + year boundaries", () => {
      expect(addDays("2024-01-31", 1)).toBe("2024-02-01");
      expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap
      expect(addDays("2023-02-28", 1)).toBe("2023-03-01"); // non-leap
      expect(addDays("2023-12-31", 1)).toBe("2024-01-01");
      expect(addDays("2024-01-01", -1)).toBe("2023-12-31");
    });

    it("round-trips with dayDiff across a DST boundary", () => {
      const start = "2024-03-08";
      expect(addDays(start, 14)).toBe("2024-03-22");
      expect(dayDiff(addDays(start, 14), start)).toBe(14);
    });
  });

  describe("roundHalf", () => {
    it("rounds half UP (away from zero), matching Swift toNearestOrAwayFromZero", () => {
      expect(roundHalf(2.5)).toBe(3);
      expect(roundHalf(0.5)).toBe(1);
      expect(roundHalf(-2.5)).toBe(-3);
      expect(roundHalf(-0.5)).toBe(-1);
    });

    it("rounds to k decimal places", () => {
      expect(roundHalf(2.345, 2)).toBe(2.35);
      expect(roundHalf(-2.345, 2)).toBe(-2.35);
      expect(roundHalf(0.155, 2)).toBe(0.16);
    });

    it("passes non-finite through unchanged", () => {
      expect(roundHalf(NaN)).toBeNaN();
      expect(roundHalf(Infinity)).toBe(Infinity);
    });
  });

  describe("isOnOrBefore / isWithin", () => {
    it("handles inclusive spans", () => {
      expect(isOnOrBefore("2024-01-01", "2024-01-01")).toBe(true);
      expect(isOnOrBefore("2024-01-02", "2024-01-01")).toBe(false);
      expect(isWithin("2024-01-05", "2024-01-01", "2024-01-10")).toBe(true);
      expect(isWithin("2024-01-01", "2024-01-01", "2024-01-10")).toBe(true);
      expect(isWithin("2024-01-10", "2024-01-01", "2024-01-10")).toBe(true);
      expect(isWithin("2024-01-11", "2024-01-01", "2024-01-10")).toBe(false);
    });
  });
});
