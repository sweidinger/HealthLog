import { describe, expect, it } from "vitest";

import {
  buildRows,
  defaultBandForTime,
  entriesByTime,
  hhmmToMinutes,
  isExplicitRange,
  isOrderedRange,
  isValidHhmm,
  lateTailDays,
  lateTailEndHhmm,
  minutesToHhmm,
  rowsToEntries,
  type DoseWindowEntry,
  type DoseWindowRow,
} from "../dose-window";

describe("dose-window helpers", () => {
  describe("hh:mm conversion", () => {
    it("round-trips minutes", () => {
      expect(hhmmToMinutes("07:00")).toBe(420);
      expect(hhmmToMinutes("00:00")).toBe(0);
      expect(hhmmToMinutes("23:59")).toBe(1439);
      expect(minutesToHhmm(420)).toBe("07:00");
      expect(minutesToHhmm(0)).toBe("00:00");
    });

    it("wraps minutes into the day", () => {
      expect(minutesToHhmm(-60)).toBe("23:00");
      expect(minutesToHhmm(1440 + 30)).toBe("00:30");
    });

    it("validates HH:mm", () => {
      expect(isValidHhmm("07:00")).toBe(true);
      expect(isValidHhmm("24:00")).toBe(false);
      expect(isValidHhmm("7:00")).toBe(false);
      expect(isValidHhmm("07:60")).toBe(false);
    });
  });

  describe("defaultBandForTime", () => {
    it("centres a ±1h band on the dose time", () => {
      expect(defaultBandForTime("08:00")).toEqual({
        start: "07:00",
        end: "09:00",
      });
      expect(defaultBandForTime("19:00")).toEqual({
        start: "18:00",
        end: "20:00",
      });
    });

    it("wraps a band near midnight", () => {
      expect(defaultBandForTime("00:30")).toEqual({
        start: "23:30",
        end: "01:30",
      });
    });
  });

  describe("late tail", () => {
    it("intraday returns end + 3h", () => {
      // dailyOverdueMinutes = 240 - 60 = 180.
      expect(lateTailEndHhmm("09:00", "intraday")).toBe("12:00");
    });

    it("day-scale returns null HH:mm (counted in days)", () => {
      expect(lateTailEndHhmm("09:00", "dayScale")).toBeNull();
    });

    it("exposes the 4-day day-scale tail", () => {
      expect(lateTailDays()).toBe(4);
    });
  });

  describe("isExplicitRange", () => {
    it("is false for a point-equivalent band", () => {
      expect(
        isExplicitRange({ timeOfDay: "08:00", start: "07:00", end: "09:00" }),
      ).toBe(false);
    });

    it("is true for a widened band", () => {
      expect(
        isExplicitRange({ timeOfDay: "08:00", start: "07:00", end: "11:00" }),
      ).toBe(true);
      expect(
        isExplicitRange({ timeOfDay: "08:00", start: "08:00", end: "09:00" }),
      ).toBe(true);
    });
  });

  describe("entriesByTime", () => {
    it("indexes by timeOfDay and tolerates undefined", () => {
      expect(entriesByTime(undefined).size).toBe(0);
      const map = entriesByTime([
        { timeOfDay: "08:00", start: "07:00", end: "11:00" },
      ]);
      expect(map.get("08:00")?.end).toBe("11:00");
    });
  });

  describe("buildRows", () => {
    it("sorts times and applies stored explicit ranges", () => {
      const rows = buildRows(
        ["20:00", "08:00"],
        [{ timeOfDay: "08:00", start: "07:00", end: "12:00" }],
      );
      expect(rows.map((r) => r.timeOfDay)).toEqual(["08:00", "20:00"]);
      expect(rows[0]).toEqual({
        timeOfDay: "08:00",
        start: "07:00",
        end: "12:00",
        custom: true,
      });
      // 20:00 has no stored window → default ±1h, not custom.
      expect(rows[1]).toEqual({
        timeOfDay: "20:00",
        start: "19:00",
        end: "21:00",
        custom: false,
      });
    });

    it("treats a point-equivalent stored entry as the default (not custom)", () => {
      const rows = buildRows(
        ["08:00"],
        [{ timeOfDay: "08:00", start: "07:00", end: "09:00" }],
      );
      expect(rows[0].custom).toBe(false);
    });

    it("drops malformed times", () => {
      expect(buildRows(["bad", "08:00"], []).map((r) => r.timeOfDay)).toEqual([
        "08:00",
      ]);
    });
  });

  describe("rowsToEntries", () => {
    it("keeps only custom rows that differ from default", () => {
      const rows: DoseWindowRow[] = [
        { timeOfDay: "08:00", start: "07:00", end: "12:00", custom: true },
        { timeOfDay: "20:00", start: "19:00", end: "21:00", custom: false },
        // custom flag on, but band equals default → dropped.
        { timeOfDay: "12:00", start: "11:00", end: "13:00", custom: true },
      ];
      const out = rowsToEntries(rows);
      expect(out).toEqual<DoseWindowEntry[]>([
        { timeOfDay: "08:00", start: "07:00", end: "12:00" },
      ]);
    });

    it("drops rows with malformed bounds", () => {
      const rows: DoseWindowRow[] = [
        { timeOfDay: "08:00", start: "07:00", end: "", custom: true },
      ];
      expect(rowsToEntries(rows)).toEqual([]);
    });
  });

  describe("isOrderedRange", () => {
    it("accepts start <= end", () => {
      expect(isOrderedRange("07:00", "09:00")).toBe(true);
      expect(isOrderedRange("09:00", "09:00")).toBe(true);
    });

    it("rejects start > end and malformed input", () => {
      expect(isOrderedRange("10:00", "09:00")).toBe(false);
      expect(isOrderedRange("bad", "09:00")).toBe(false);
    });
  });
});
