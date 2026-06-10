import { describe, it, expect } from "vitest";
import {
  makeFormatters,
  parseLocaleFromAcceptLanguage,
  resolveIntlLocale,
} from "../format-locale";

describe("resolveIntlLocale", () => {
  it("maps short locales to BCP-47 tags", () => {
    expect(resolveIntlLocale("de")).toBe("de-DE");
    expect(resolveIntlLocale("en")).toBe("en-US");
  });
});

describe("parseLocaleFromAcceptLanguage", () => {
  it("returns en for null / empty", () => {
    expect(parseLocaleFromAcceptLanguage(null)).toBe("en");
    expect(parseLocaleFromAcceptLanguage("")).toBe("en");
  });

  it("returns de for primary German tag", () => {
    expect(parseLocaleFromAcceptLanguage("de-DE,en;q=0.9")).toBe("de");
    expect(parseLocaleFromAcceptLanguage("de")).toBe("de");
    expect(parseLocaleFromAcceptLanguage("de-CH")).toBe("de");
  });

  it("returns en for English or unrecognised locales", () => {
    expect(parseLocaleFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(parseLocaleFromAcceptLanguage("ja-JP")).toBe("en");
    expect(parseLocaleFromAcceptLanguage("*")).toBe("en");
  });

  // v1.4.25 W9e — the four AI-initial locales added in this release.
  // Each maps via the same primary-tag prefix match the DE branch uses.
  it("returns the matching tag for FR / ES / IT / PL", () => {
    expect(parseLocaleFromAcceptLanguage("fr-FR,fr;q=0.9")).toBe("fr");
    expect(parseLocaleFromAcceptLanguage("es-ES")).toBe("es");
    expect(parseLocaleFromAcceptLanguage("es-MX")).toBe("es");
    expect(parseLocaleFromAcceptLanguage("it-IT")).toBe("it");
    expect(parseLocaleFromAcceptLanguage("pl-PL")).toBe("pl");
    expect(parseLocaleFromAcceptLanguage("pl")).toBe("pl");
  });
});

describe("makeFormatters", () => {
  const deFmt = makeFormatters("de");
  const enFmt = makeFormatters("en");
  const sample = new Date("2026-04-18T14:30:00Z"); // 16:30 Europe/Berlin (CEST)

  it("formats numbers with regional decimal separators", () => {
    expect(deFmt.number(70.5, 1)).toMatch(/70,5/);
    expect(enFmt.number(70.5, 1)).toMatch(/70\.5/);
  });

  it("formats integers with thousands separators", () => {
    expect(deFmt.integer(1234567)).toMatch(/1[.\u202f]234[.\u202f]567/);
    expect(enFmt.integer(1234567)).toBe("1,234,567");
  });

  it("formats percent", () => {
    expect(deFmt.percent(0.835, 1)).toMatch(/83,5\s*%/);
    expect(enFmt.percent(0.835, 1)).toMatch(/83\.5%/);
  });

  it("formats date in Europe/Berlin", () => {
    // Both should include day/month/year; locale-specific order differs.
    expect(deFmt.date(sample)).toContain("2026");
    expect(enFmt.date(sample)).toContain("2026");
  });

  // v1.15.20 — the hour cycle follows the locale convention by default
  // (AUTO). Pre-v1.15.20 both locales were pinned to 24h via `hour12:
  // false`; the explicit preference replaced the pin.
  it("formats time per the locale convention under AUTO", () => {
    expect(deFmt.time(sample)).toBe("16:30");
    expect(enFmt.time(sample)).toBe("04:30 PM");
  });

  describe("hour-cycle preference (v1.15.20)", () => {
    it("AUTO follows the locale default for time + dateTime", () => {
      const de = makeFormatters("de", undefined, "AUTO");
      const en = makeFormatters("en", undefined, "AUTO");
      expect(de.time(sample)).toBe("16:30");
      expect(en.time(sample)).toBe("04:30 PM");
      expect(de.dateTime(sample)).toBe("18.04.2026, 16:30");
      expect(en.dateTime(sample)).toBe("04/18/2026, 04:30 PM");
    });

    it("H12 forces AM/PM regardless of locale", () => {
      const de = makeFormatters("de", undefined, "H12");
      const en = makeFormatters("en", undefined, "H12");
      expect(de.time(sample)).toContain("PM");
      expect(en.time(sample)).toBe("04:30 PM");
      expect(de.dateTime(sample)).toContain("PM");
    });

    it("H24 forces the 24-hour clock regardless of locale", () => {
      const de = makeFormatters("de", undefined, "H24");
      const en = makeFormatters("en", undefined, "H24");
      expect(de.time(sample)).toBe("16:30");
      expect(en.time(sample)).toBe("16:30");
      expect(en.dateTime(sample)).toBe("04/18/2026, 16:30");
    });

    it("H24 renders midnight as 00, never 24 (h23 cycle)", () => {
      const midnight = new Date("2026-04-18T22:30:00Z"); // 00:30 Berlin CEST
      const en = makeFormatters("en", undefined, "H24");
      expect(en.time(midnight)).toBe("00:30");
    });

    it("does not affect date-only formatters", () => {
      const auto = makeFormatters("en", undefined, "AUTO");
      const h24 = makeFormatters("en", undefined, "H24");
      expect(auto.date(sample)).toBe(h24.date(sample));
      expect(auto.dateShort(sample)).toBe(h24.dateShort(sample));
    });
  });

  // v1.4.25 W7 — formatters accept a per-user timezone override.
  it("renders time in the user's tz when userTz is passed", () => {
    const tokyo = makeFormatters("en", "Asia/Tokyo", "H24");
    // 14:30 UTC = 23:30 Tokyo
    expect(tokyo.time(sample)).toBe("23:30");
  });

  it("renders time in Europe/Berlin when userTz is empty", () => {
    const fallback = makeFormatters("en", "", "H24");
    expect(fallback.time(sample)).toBe("16:30");
  });

  it("renders date in the user's tz when userTz is passed", () => {
    // 23:30 UTC on May 10 = 01:30 May 11 Tokyo
    const lateUtc = new Date("2026-05-10T23:30:00Z");
    const tokyo = makeFormatters("en", "Asia/Tokyo");
    expect(tokyo.date(lateUtc)).toMatch(/2026/);
    // The narrow check: day-of-month should be 11, not 10.
    expect(tokyo.date(lateUtc)).toMatch(/11/);
  });
});
