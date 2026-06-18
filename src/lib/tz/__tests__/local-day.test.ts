import { describe, expect, it } from "vitest";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";
import { wallClockInTz } from "@/lib/tz/wall-clock";

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
