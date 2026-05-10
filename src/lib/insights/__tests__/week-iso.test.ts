import { describe, it, expect } from "vitest";
import { parseWeekISO, toWeekISO, weekISOToRange } from "../week-iso";

describe("parseWeekISO", () => {
  it("accepts a valid YYYY-Www identifier", () => {
    expect(parseWeekISO("2026-W19")).toEqual({
      weekISO: "2026-W19",
      year: 2026,
      week: 19,
    });
  });

  it("accepts the boundary weeks 01 and 53", () => {
    expect(parseWeekISO("2026-W01")?.week).toBe(1);
    expect(parseWeekISO("2026-W53")?.week).toBe(53);
  });

  it("rejects malformed input", () => {
    expect(parseWeekISO("2026-W9")).toBeNull(); // single-digit week
    expect(parseWeekISO("2026/W19")).toBeNull();
    expect(parseWeekISO("26-W19")).toBeNull();
    expect(parseWeekISO("not-a-week")).toBeNull();
  });

  it("rejects out-of-range week numbers", () => {
    expect(parseWeekISO("2026-W00")).toBeNull();
    expect(parseWeekISO("2026-W54")).toBeNull();
  });
});

describe("toWeekISO", () => {
  it("returns 2026-W19 for a date inside ISO week 19 of 2026", () => {
    // 2026-05-07 is a Thursday; ISO week 19.
    expect(toWeekISO(new Date(Date.UTC(2026, 4, 7)))).toBe("2026-W19");
  });

  it("rolls Sunday into the same week as the preceding Monday", () => {
    // 2026-05-10 is the Sunday closing ISO week 19.
    expect(toWeekISO(new Date(Date.UTC(2026, 4, 10)))).toBe("2026-W19");
  });

  it("returns the new week starting Monday", () => {
    // 2026-05-11 is the Monday opening ISO week 20.
    expect(toWeekISO(new Date(Date.UTC(2026, 4, 11)))).toBe("2026-W20");
  });

  it("zero-pads the week number to two digits", () => {
    // 2026-01-02 is a Friday, still in ISO week 1 of 2026.
    expect(toWeekISO(new Date(Date.UTC(2026, 0, 2)))).toMatch(/^2026-W01$/);
  });
});

describe("weekISOToRange", () => {
  it("returns Monday + Sunday for a known week", () => {
    const range = weekISOToRange("2026-W19");
    expect(range).not.toBeNull();
    expect(range?.start.toISOString().slice(0, 10)).toBe("2026-05-04");
    expect(range?.end.toISOString().slice(0, 10)).toBe("2026-05-10");
  });

  it("round-trips toWeekISO -> weekISOToRange -> toWeekISO", () => {
    const date = new Date(Date.UTC(2026, 4, 7));
    const week = toWeekISO(date);
    const range = weekISOToRange(week);
    expect(range).not.toBeNull();
    if (range) {
      expect(toWeekISO(range.start)).toBe(week);
      expect(toWeekISO(range.end)).toBe(week);
    }
  });

  it("returns null for malformed input", () => {
    expect(weekISOToRange("not-a-week")).toBeNull();
  });
});
