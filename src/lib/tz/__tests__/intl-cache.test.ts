/**
 * v1.16.8 — memoised `Intl.DateTimeFormat` construction.
 *
 * Constructing a formatter dominates the CPU cost of the wall-clock
 * helpers (band expansion calls them in a tight loop), so the memo must
 * (a) return byte-identical output to a freshly constructed formatter
 * for every timezone / option shape the tz helpers use, and (b) actually
 * share one instance per signature.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  getDateTimeFormat,
  __resetIntlCacheForTests,
  __intlCacheSizeForTests,
} from "../intl-cache";
import { wallClockInTz } from "../wall-clock";
import { formatInUserTz, userDayKey, isValidTimezone } from "../format";
import { getUserTodayBounds, localHmAsUtc } from "../local-day";

const ZONES = [
  "UTC",
  "Europe/Berlin",
  "America/New_York",
  "Asia/Tokyo",
  "Pacific/Kiritimati", // +14, no DST
  "America/St_Johns", // -03:30 fractional offset
];

// Instants chosen to straddle DST transitions and a midnight boundary.
const INSTANTS = [
  new Date("2026-01-15T03:30:00Z"),
  new Date("2026-03-29T01:30:00Z"), // EU spring-forward window
  new Date("2026-06-10T23:45:00Z"),
  new Date("2026-10-25T01:30:00Z"), // EU fall-back window
];

beforeEach(() => {
  __resetIntlCacheForTests();
});

describe("getDateTimeFormat", () => {
  it("matches a freshly constructed formatter across zones and option shapes", () => {
    const optionShapes: Omit<Intl.DateTimeFormatOptions, "timeZone">[] = [
      {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        weekday: "short",
      },
      {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      },
      { hour: "2-digit", minute: "2-digit", hour12: false },
    ];
    for (const tz of ZONES) {
      for (const options of optionShapes) {
        const memoised = getDateTimeFormat("en-CA", tz, options);
        const fresh = new Intl.DateTimeFormat("en-CA", {
          ...options,
          timeZone: tz,
        });
        for (const instant of INSTANTS) {
          expect(memoised.format(instant)).toBe(fresh.format(instant));
          expect(memoised.formatToParts(instant)).toEqual(
            fresh.formatToParts(instant),
          );
        }
      }
    }
  });

  it("returns the same instance for the same (locale, timeZone, options) signature", () => {
    const options = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    } as const;
    const a = getDateTimeFormat("en-GB", "Europe/Berlin", options);
    const b = getDateTimeFormat("en-GB", "Europe/Berlin", options);
    expect(a).toBe(b);
    // A structurally equal but distinct options object still hits the
    // same cache cell (signature-keyed, not identity-keyed).
    const c = getDateTimeFormat("en-GB", "Europe/Berlin", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    } as const);
    expect(c).toBe(a);
  });

  it("splits cells on locale, timezone, and options", () => {
    const options = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    } as const;
    const base = getDateTimeFormat("en-GB", "Europe/Berlin", options);
    expect(getDateTimeFormat("en-US", "Europe/Berlin", options)).not.toBe(base);
    expect(getDateTimeFormat("en-GB", "Asia/Tokyo", options)).not.toBe(base);
    expect(
      getDateTimeFormat("en-GB", "Europe/Berlin", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      } as const),
    ).not.toBe(base);
    expect(__intlCacheSizeForTests()).toBe(4);
  });

  it("throws on an invalid timezone without caching the failure", () => {
    expect(() => getDateTimeFormat("en-US", "Not/AZone", {})).toThrow();
    expect(__intlCacheSizeForTests()).toBe(0);
  });
});

describe("memoised consumers stay output-identical to the pre-memo helpers", () => {
  it("wallClockInTz decomposes DST-transition instants correctly", () => {
    // 2026-03-29 01:30 UTC = 03:30 CEST (the EU spring-forward morning).
    const parts = wallClockInTz(
      new Date("2026-03-29T01:30:00Z"),
      "Europe/Berlin",
    );
    expect(parts).toEqual({
      year: 2026,
      month: 3,
      day: 29,
      hour: 3,
      minute: 30,
      second: 0,
      weekday: 0,
    });
    // Same instant read from Tokyo.
    const tokyo = wallClockInTz(new Date("2026-03-29T01:30:00Z"), "Asia/Tokyo");
    expect(tokyo).toEqual({
      year: 2026,
      month: 3,
      day: 29,
      hour: 10,
      minute: 30,
      second: 0,
      weekday: 0,
    });
  });

  it("formatInUserTz keeps every shape stable across repeat (memo-warm) calls", () => {
    const instant = new Date("2026-06-10T23:45:00Z");
    for (let i = 0; i < 2; i++) {
      expect(formatInUserTz(instant, "Europe/Berlin", "iso-with-offset")).toBe(
        "2026-06-11T01:45:00+02:00",
      );
      expect(formatInUserTz(instant, "Europe/Berlin", "wall-clock")).toBe(
        "01:45",
      );
      expect(formatInUserTz(instant, "Europe/Berlin", "date")).toBe(
        "2026-06-11",
      );
      expect(userDayKey(instant, "America/New_York")).toBe("2026-06-10");
    }
  });

  it("getUserTodayBounds + localHmAsUtc agree with the wall-clock read", () => {
    const now = new Date("2026-06-10T23:45:00Z"); // 01:45 on the 11th in Berlin
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");
    expect(start.toISOString()).toBe("2026-06-10T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-11T21:59:59.999Z");
    const eight = localHmAsUtc(now, "Europe/Berlin", 8, 0);
    expect(eight.toISOString()).toBe("2026-06-11T06:00:00.000Z");
  });

  it("isValidTimezone accepts real zones and rejects junk through the memo", () => {
    expect(isValidTimezone("Europe/Berlin")).toBe(true);
    expect(isValidTimezone("Pacific/Kiritimati")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("overflow eviction", () => {
  it("evicts only the single oldest entry on overflow, never the whole map", () => {
    // The memo caps at 1000 entries. Fill it to the cap with real
    // signatures (IANA zones × option shapes), then overflow by one and
    // assert the population stays at the cap with only the OLDEST
    // signature gone — a full reset would re-pay construction for every
    // hot signature after one burst of unusual zones.
    const zones = (
      Intl as unknown as { supportedValuesOf: (k: string) => string[] }
    ).supportedValuesOf("timeZone");
    const shapes: Array<Omit<Intl.DateTimeFormatOptions, "timeZone">> = [
      { hour: "2-digit" },
      { minute: "2-digit" },
      { second: "2-digit" },
    ];

    const CAP = 1000;
    const inserted: Array<{
      zone: string;
      opts: Omit<Intl.DateTimeFormatOptions, "timeZone">;
      formatter: Intl.DateTimeFormat;
    }> = [];
    outer: for (const opts of shapes) {
      for (const zone of zones) {
        inserted.push({
          zone,
          opts,
          formatter: getDateTimeFormat("en-US", zone, opts),
        });
        if (inserted.length === CAP) break outer;
      }
    }
    expect(__intlCacheSizeForTests()).toBe(CAP);

    // One more unique signature → exactly one eviction.
    const overflowOpts: Omit<Intl.DateTimeFormatOptions, "timeZone"> = {
      year: "numeric",
    };
    getDateTimeFormat("en-US", "UTC", overflowOpts);
    expect(__intlCacheSizeForTests()).toBe(CAP);

    // The SECOND-oldest entry survived (same memoised instance)…
    const second = inserted[1];
    expect(getDateTimeFormat("en-US", second.zone, second.opts)).toBe(
      second.formatter,
    );
    // …while the oldest was evicted and re-constructs to a NEW instance.
    const first = inserted[0];
    expect(getDateTimeFormat("en-US", first.zone, first.opts)).not.toBe(
      first.formatter,
    );
  });
});
