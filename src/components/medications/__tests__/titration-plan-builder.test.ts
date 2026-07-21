/**
 * Fork ADHS Stage C — titration plan-builder pure helpers.
 *
 * The builder's only non-trivial logic is turning a start date + interval into
 * per-step calendar dates and parsing user-typed doses. These are the safety-
 * relevant bits: the date math must not drift across month/year/DST boundaries,
 * and `parseDoseValue` must NEVER invent a value — blank / zero / negative /
 * junk all resolve to null so no step is ever written with a fabricated dose.
 */
import { describe, expect, it } from "vitest";

import {
  addDaysIso,
  stepDateIso,
  parseDoseValue,
  isoDateToEffectiveFrom,
} from "../titration-plan-builder";

describe("addDaysIso", () => {
  it("adds days within a month", () => {
    expect(addDaysIso("2026-08-01", 7)).toBe("2026-08-08");
  });
  it("crosses a month boundary", () => {
    expect(addDaysIso("2026-08-28", 7)).toBe("2026-09-04");
  });
  it("crosses a year boundary", () => {
    expect(addDaysIso("2026-12-30", 7)).toBe("2027-01-06");
  });
  it("handles a leap day", () => {
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("stepDateIso", () => {
  it("spaces steps by the interval from the start", () => {
    expect(stepDateIso("2026-08-01", 0, 7)).toBe("2026-08-01");
    expect(stepDateIso("2026-08-01", 1, 7)).toBe("2026-08-08");
    expect(stepDateIso("2026-08-01", 2, 7)).toBe("2026-08-15");
  });
  it("supports a bi-weekly interval", () => {
    expect(stepDateIso("2026-08-01", 2, 14)).toBe("2026-08-29");
  });
});

describe("parseDoseValue — never fabricates a value", () => {
  it("parses a plain number", () => {
    expect(parseDoseValue("30")).toBe(30);
  });
  it("accepts a comma decimal separator", () => {
    expect(parseDoseValue("2,5")).toBe(2.5);
    expect(parseDoseValue("2.5")).toBe(2.5);
  });
  it("returns null for blank / zero / negative / junk", () => {
    for (const bad of ["", "   ", "0", "-5", "abc", "1,2,3"]) {
      expect(parseDoseValue(bad)).toBeNull();
    }
  });
});

describe("isoDateToEffectiveFrom", () => {
  it("anchors the calendar day at noon UTC (no tz date shift)", () => {
    expect(isoDateToEffectiveFrom("2026-08-01")).toBe(
      "2026-08-01T12:00:00.000Z",
    );
  });
});
