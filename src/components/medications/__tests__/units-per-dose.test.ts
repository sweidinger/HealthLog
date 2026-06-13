/**
 * v1.16.12 (#316) — fractional-dosing UI mapping.
 *
 * The wizard's fraction buttons must never offer a value the server's
 * validator would 422. This pins that contract: the selector's fraction
 * values equal {@link UNITS_PER_DOSE_FRACTIONS}, every offered option
 * passes {@link isSupportedUnitsPerDose}, the glyph formatting round-trips,
 * and a legacy / non-curated value is preserved as an extra option.
 */
import { describe, expect, it } from "vitest";

import {
  UNITS_PER_DOSE_FRACTIONS,
  isSupportedUnitsPerDose,
} from "@/lib/validations/medication";
import {
  UNITS_PER_DOSE_OPTIONS,
  UNITS_PER_DOSE_FRACTION_VALUES,
  formatUnitsPerDose,
  formatUnitCount,
  unitsPerDoseOptionsFor,
} from "@/components/medications/units-per-dose";

describe("units-per-dose selector ↔ validator alignment", () => {
  it("offers exactly the validator's fraction set", () => {
    expect([...UNITS_PER_DOSE_FRACTION_VALUES].sort()).toEqual(
      [...UNITS_PER_DOSE_FRACTIONS].sort(),
    );
  });

  it("offers only server-accepted values", () => {
    for (const opt of UNITS_PER_DOSE_OPTIONS) {
      expect(isSupportedUnitsPerDose(opt.value)).toBe(true);
      // The payload string round-trips to the same number.
      expect(Number(opt.raw)).toBe(opt.value);
    }
  });
});

describe("formatUnitsPerDose", () => {
  it("renders curated fractions as glyphs", () => {
    expect(formatUnitsPerDose(0.25)).toBe("¼");
    expect(formatUnitsPerDose(0.3333)).toBe("⅓");
    expect(formatUnitsPerDose(0.5)).toBe("½");
    expect(formatUnitsPerDose(0.6667)).toBe("⅔");
    expect(formatUnitsPerDose(0.75)).toBe("¾");
  });

  it("renders whole / uncurated values as the plain number", () => {
    expect(formatUnitsPerDose(1)).toBe("1");
    expect(formatUnitsPerDose(2)).toBe("2");
    expect(formatUnitsPerDose(10)).toBe("10");
  });
});

describe("formatUnitCount — display rounding", () => {
  it("passes whole and half counts through unchanged", () => {
    expect(formatUnitCount(30)).toBe(30);
    expect(formatUnitCount(29.5)).toBe(29.5);
  });

  it("rounds the float noise a third-dose leaves", () => {
    expect(formatUnitCount(29.6667)).toBe(29.67);
  });
});

describe("unitsPerDoseOptionsFor", () => {
  it("returns the curated set for a curated current value", () => {
    expect(unitsPerDoseOptionsFor("0.5")).toBe(UNITS_PER_DOSE_OPTIONS);
    expect(unitsPerDoseOptionsFor("2")).toBe(UNITS_PER_DOSE_OPTIONS);
  });

  it("appends a legacy / non-curated current value so an edit never drops it", () => {
    const opts = unitsPerDoseOptionsFor("10");
    expect(opts).toHaveLength(UNITS_PER_DOSE_OPTIONS.length + 1);
    expect(opts.at(-1)).toEqual({ value: 10, raw: "10", label: "10" });
  });

  it("ignores an empty / invalid current value", () => {
    expect(unitsPerDoseOptionsFor("")).toBe(UNITS_PER_DOSE_OPTIONS);
  });
});
