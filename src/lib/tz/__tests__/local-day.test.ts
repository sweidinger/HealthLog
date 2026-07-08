import { describe, expect, it } from "vitest";
import { getUserTodayBounds, startOfLocalDayInTz } from "@/lib/tz/local-day";
import { wallClockInTz, zonedWallClockToUtc } from "@/lib/tz/wall-clock";

const HOUR_MS = 60 * 60 * 1000;

describe("zonedWallClockToUtc", () => {
  it("resolves a wall clock in a positive-offset zone to the right UTC instant", () => {
    // 00:30 CEST (UTC+2) on 2026-05-11 → 22:30 UTC on 2026-05-10.
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 5, day: 11, hour: 0, minute: 30 },
      "Europe/Berlin",
    );
    expect(utc.toISOString()).toBe("2026-05-10T22:30:00.000Z");
  });

  it("round-trips through wallClockInTz across the spring-forward boundary", () => {
    // 03:30 local on Berlin's spring-forward day (clocks jumped 02:00→03:00).
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30 },
      "Europe/Berlin",
    );
    const parts = wallClockInTz(utc, "Europe/Berlin");
    expect(parts.hour).toBe(3);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(29);
  });

  it("resolves a negative-offset zone", () => {
    // 00:30 NZST (UTC+12) on 2026-06-15 → 12:30 UTC on 2026-06-14.
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 6, day: 15, hour: 0, minute: 30 },
      "Pacific/Auckland",
    );
    expect(utc.toISOString()).toBe("2026-06-14T12:30:00.000Z");
  });

  it("falls back to host-local when tz is undefined", () => {
    const utc = zonedWallClockToUtc(
      { year: 2026, month: 6, day: 15, hour: 14, minute: 30, second: 15 },
      undefined,
    );
    expect(utc.getTime()).toBe(new Date(2026, 5, 15, 14, 30, 15).getTime());
  });
});

describe("startOfLocalDayInTz", () => {
  it("anchors at the user's local midnight, not UTC midnight", () => {
    // 2026-06-15 22:00 UTC is already 2026-06-16 00:00 in Berlin (UTC+2),
    // so the local day floor must land on the Berlin 2026-06-16 midnight
    // instant (2026-06-15T22:00:00Z) — never 2026-06-16T00:00:00Z.
    const instant = new Date("2026-06-15T23:30:00.000Z");
    const floor = startOfLocalDayInTz(instant, "Europe/Berlin");
    const parts = wallClockInTz(floor, "Europe/Berlin");
    expect(parts.hour).toBe(0);
    expect(parts.minute).toBe(0);
    expect(parts.second).toBe(0);
    expect(floor.toISOString()).toBe("2026-06-15T22:00:00.000Z");
  });

  it("handles negative offsets (Pacific/Auckland) — late-local reading stays on its day", () => {
    // 2026-06-15 23:30 NZST (UTC+12) is 2026-06-15T11:30Z; the local day
    // floor is Auckland 2026-06-15 midnight = 2026-06-14T12:00:00Z.
    const instant = new Date("2026-06-15T11:30:00.000Z");
    const floor = startOfLocalDayInTz(instant, "Pacific/Auckland");
    const parts = wallClockInTz(floor, "Pacific/Auckland");
    expect(parts.hour).toBe(0);
    expect(parts.day).toBe(15);
  });

  it("is DST-safe across the spring-forward boundary", () => {
    // Europe/Berlin springs forward 2026-03-29 02:00→03:00.
    const instant = new Date("2026-03-29T10:00:00.000Z");
    const floor = startOfLocalDayInTz(instant, "Europe/Berlin");
    const parts = wallClockInTz(floor, "Europe/Berlin");
    expect(parts.hour).toBe(0);
    expect(parts.day).toBe(29);
  });

  it("falls back to host-local day when tz is undefined", () => {
    const instant = new Date(2026, 5, 15, 14, 30, 0);
    const floor = startOfLocalDayInTz(instant, undefined);
    expect(floor.getHours()).toBe(0);
    expect(floor.getDate()).toBe(15);
  });
});

describe("getUserTodayBounds — DST-safe local-day window", () => {
  it("spans a full 24h on an ordinary (non-transition) day", () => {
    const now = new Date("2026-06-15T14:30:00.000Z");
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");
    // Berlin is CEST (UTC+2) in June: local midnight = 2026-06-14T22:00Z.
    expect(start.toISOString()).toBe("2026-06-14T22:00:00.000Z");
    // Inclusive end is the last ms before the next local midnight.
    expect(end.getTime() - start.getTime()).toBe(24 * HOUR_MS - 1);
  });

  it("fall-back day is 25h and keeps a 23:30-local dose inside 'today'", () => {
    // Europe/Berlin falls back 2026-10-25 03:00→02:00 (a 25-hour local day).
    // A read taken at 23:30 local that evening.
    const now = zonedWallClockToUtc(
      { year: 2026, month: 10, day: 25, hour: 23, minute: 30 },
      "Europe/Berlin",
    );
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");

    // The window covers the real 25-hour local day, not a hardcoded 24h.
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR_MS - 1);

    // The 23:30 dose — which the old 24h window dropped off the med cards —
    // now falls inside [start, end].
    const dose2330 = zonedWallClockToUtc(
      { year: 2026, month: 10, day: 25, hour: 23, minute: 30 },
      "Europe/Berlin",
    );
    expect(dose2330.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(dose2330.getTime()).toBeLessThanOrEqual(end.getTime());

    // Both bounds sit at local midnight of their respective calendar days.
    expect(wallClockInTz(start, "Europe/Berlin").hour).toBe(0);
    expect(wallClockInTz(start, "Europe/Berlin").day).toBe(25);
  });

  it("spring-forward day is 23h and does not bleed into tomorrow's 00:30 dose", () => {
    // Europe/Berlin springs forward 2026-03-29 02:00→03:00 (a 23-hour day).
    const now = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 20, minute: 0 },
      "Europe/Berlin",
    );
    const { start, end } = getUserTodayBounds(now, "Europe/Berlin");

    // The window covers only the real 23-hour local day.
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR_MS - 1);

    // Tomorrow's 00:30 dose belongs to 2026-03-30, so it must fall OUTSIDE
    // today — the old fixed-24h window double-counted it as "today".
    const tomorrow0030 = zonedWallClockToUtc(
      { year: 2026, month: 3, day: 30, hour: 0, minute: 30 },
      "Europe/Berlin",
    );
    expect(tomorrow0030.getTime()).toBeGreaterThan(end.getTime());
  });

  it("is correct for a negative-offset zone (America/Los_Angeles)", () => {
    // 2026-06-15 20:00 PDT (UTC-7) → 2026-06-16T03:00Z. The local day is
    // still the 15th, so the window must anchor on LA's 2026-06-15 midnight.
    const now = new Date("2026-06-16T03:00:00.000Z");
    const { start, end } = getUserTodayBounds(now, "America/Los_Angeles");
    expect(start.toISOString()).toBe("2026-06-15T07:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(24 * HOUR_MS - 1);
    expect(wallClockInTz(start, "America/Los_Angeles").day).toBe(15);
  });
});
