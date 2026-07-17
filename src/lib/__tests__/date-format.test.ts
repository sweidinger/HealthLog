/**
 * Date-order preference resolver + formatter (v1.21.0).
 *
 * `formatDate` and `resolveDateLocale` are the single source of truth for the
 * field order the `<DateField>` primitive and `useFormatters().date()` render.
 * AUTO defers to the active locale; DMY / MDY / YMD pin the order regardless.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatDate,
  formatDateWithWeekday,
  formatDateWithWeekdaySmart,
  parseIsoDate,
  resolveDateLocale,
  isDateFormatPreference,
  DATE_FORMAT_PREFERENCES,
  DATE_FORMAT_OPTIONS,
} from "../date-format";

const ISO = "2026-02-19";

describe("resolveDateLocale", () => {
  it("AUTO follows the active locale", () => {
    expect(resolveDateLocale("AUTO", "de")).toBe("de-DE");
    expect(resolveDateLocale("AUTO", "en")).toBe("en-US");
    expect(resolveDateLocale("AUTO", "fr")).toBe("fr-FR");
  });

  it("DMY / MDY / YMD pin a canonical order locale regardless of UI locale", () => {
    expect(resolveDateLocale("DMY", "en")).toBe("de-DE");
    expect(resolveDateLocale("MDY", "de")).toBe("en-US");
    expect(resolveDateLocale("YMD", "de")).toBe("en-CA");
  });
});

describe("formatDate", () => {
  it("renders DMY as dd.MM.yyyy", () => {
    expect(formatDate(ISO, "DMY", "en")).toBe("19.02.2026");
  });

  it("renders MDY as MM/dd/yyyy", () => {
    expect(formatDate(ISO, "MDY", "de")).toBe("02/19/2026");
  });

  it("renders YMD as yyyy-MM-dd (ISO)", () => {
    expect(formatDate(ISO, "YMD", "de")).toBe("2026-02-19");
  });

  it("AUTO follows the locale convention", () => {
    // de → dd.MM.yyyy, en → MM/dd/yyyy
    expect(formatDate(ISO, "AUTO", "de")).toBe("19.02.2026");
    expect(formatDate(ISO, "AUTO", "en")).toBe("02/19/2026");
  });

  it("accepts a Date and an ISO string identically", () => {
    const d = new Date(Date.UTC(2026, 1, 19));
    expect(formatDate(d, "DMY", "en")).toBe(formatDate(ISO, "DMY", "en"));
  });

  it("does not drift across a timezone boundary (UTC calendar date)", () => {
    // A bare yyyy-MM-dd is a calendar date; it must render the same day in
    // every order, never the day before/after.
    expect(formatDate("2026-01-01", "DMY", "en")).toBe("01.01.2026");
    expect(formatDate("2026-12-31", "YMD", "en")).toBe("2026-12-31");
  });

  it("returns an empty string for empty / unparseable input", () => {
    expect(formatDate("", "AUTO", "en")).toBe("");
    expect(formatDate(null, "AUTO", "en")).toBe("");
    expect(formatDate(undefined, "AUTO", "en")).toBe("");
    expect(formatDate("not-a-date", "AUTO", "en")).toBe("");
  });
});

// ── Issue #490 — `@db.Date` / day-key rendering regressions ─────────────
//
// A serialised calendar date (`@db.Date` → UTC-midnight instant, or a raw
// profile-tz `yyyy-MM-dd` day key) must render the ENCODED day in every
// display zone — the pre-fix paths re-read the encoding in a timezone-aware
// formatter and shifted the day for zones west of UTC (medication one-shot
// `startsOn`) or for browser ≠ profile pairs (dose-ledger day headings).
describe("formatDateWithWeekday (#490)", () => {
  // 2026-07-14 is a Tuesday.
  it("renders a day key with its zone-independent weekday", () => {
    expect(formatDateWithWeekday("2026-07-14", "AUTO", "en")).toBe(
      "Tue, 07/14",
    );
    expect(formatDateWithWeekday("2026-07-14", "AUTO", "de")).toBe(
      "Di., 14.07.",
    );
  });

  it("honours the date-order preference like the formatter hook", () => {
    expect(formatDateWithWeekday("2026-07-14", "DMY", "en")).toBe(
      "Di., 14.07.",
    );
    expect(formatDateWithWeekday("2026-07-14", "MDY", "de")).toBe("Tue, 07/14");
  });

  it("renders a UTC-midnight Date on its encoded day (never the day before)", () => {
    // The `@db.Date` wire shape — the exact value class the medication
    // one-shot `startsOn` fix feeds through `formatDate`.
    const utcMidnight = new Date("2026-07-01T00:00:00.000Z");
    expect(formatDateWithWeekday(utcMidnight, "AUTO", "en")).toBe("Wed, 07/01");
    expect(formatDate(utcMidnight, "AUTO", "en")).toBe("07/01/2026");
  });

  it("returns an empty string for empty / unparseable input", () => {
    expect(formatDateWithWeekday("", "AUTO", "en")).toBe("");
    expect(formatDateWithWeekday(null, "AUTO", "en")).toBe("");
    expect(formatDateWithWeekday("14.07.2026", "AUTO", "en")).toBe("");
  });
});

// Issue #66 (date-format sweep) — the dose-history ledger scrolls day
// groups across year boundaries; a bare "Di., 16.12." from last December
// must not read as this year's. "Now" is faked so the boundary is
// deterministic regardless of the day this suite runs.
describe("formatDateWithWeekdaySmart (#66)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("omits the year for a day key in the current UTC year", () => {
    expect(formatDateWithWeekdaySmart("2026-07-14", "AUTO", "en")).toBe(
      "Tue, 07/14",
    );
  });

  it("adds the year for a day key from a prior UTC year", () => {
    expect(formatDateWithWeekdaySmart("2025-12-16", "AUTO", "en")).toBe(
      "Tue, 12/16/2025",
    );
    expect(formatDateWithWeekdaySmart("2025-12-16", "AUTO", "de")).toBe(
      "Di., 16.12.2025",
    );
  });

  it("returns an empty string for empty / unparseable input", () => {
    expect(formatDateWithWeekdaySmart("", "AUTO", "en")).toBe("");
    expect(formatDateWithWeekdaySmart(null, "AUTO", "en")).toBe("");
  });
});

describe("parseIsoDate", () => {
  it("parses a valid ISO calendar date to a UTC midnight Date", () => {
    const d = parseIsoDate("2026-02-19");
    expect(d).not.toBeNull();
    expect(d!.getUTCFullYear()).toBe(2026);
    expect(d!.getUTCMonth()).toBe(1);
    expect(d!.getUTCDate()).toBe(19);
  });

  it("rejects a non-ISO shape and an impossible date", () => {
    expect(parseIsoDate("19.02.2026")).toBeNull();
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toBeNull();
  });
});

describe("preference list", () => {
  it("isDateFormatPreference is a strict guard", () => {
    expect(isDateFormatPreference("AUTO")).toBe(true);
    expect(isDateFormatPreference("DMY")).toBe(true);
    expect(isDateFormatPreference("XYZ")).toBe(false);
    expect(isDateFormatPreference(null)).toBe(false);
  });

  it("exposes all four preferences and matching options", () => {
    expect(DATE_FORMAT_PREFERENCES).toEqual(["AUTO", "DMY", "MDY", "YMD"]);
    expect(DATE_FORMAT_OPTIONS.map((o) => o.value)).toEqual([
      "AUTO",
      "DMY",
      "MDY",
      "YMD",
    ]);
    for (const opt of DATE_FORMAT_OPTIONS) {
      expect(opt.labelKey).toMatch(/^settings\.dateFormat\./);
    }
  });
});
