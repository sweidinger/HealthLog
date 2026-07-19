/**
 * The next-intake day label, including the case the previous
 * implementation could not get right: a user whose BROWSER zone differs
 * from their PROFILE zone.
 *
 * Every test here pins the host zone explicitly, because the defect this
 * module exists to remove was invisible whenever host and profile agreed —
 * which is the configuration a UTC-only suite always runs in.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { resolveNextDueDayLabel } from "../next-due-day-label";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

const ORIGINAL_TZ = process.env.TZ;

/** Repoint the HOST zone — what `new Date(...)` parses offset-less text as. */
function setHostZone(tz: string): void {
  process.env.TZ = tz;
}

beforeEach(() => setHostZone("UTC"));
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const BERLIN = "Europe/Berlin";

function berlin(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return zonedWallClockToUtc({ year, month, day, hour, minute }, BERLIN);
}

describe("resolveNextDueDayLabel — profile zone drives the label", () => {
  it("names today when both instants share the profile calendar day", () => {
    const now = berlin(2026, 6, 10, 9, 0);
    const next = berlin(2026, 6, 10, 21, 0);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "today",
    });
  });

  it("names tomorrow across the profile midnight", () => {
    const now = berlin(2026, 6, 10, 23, 30);
    const next = berlin(2026, 6, 11, 0, 30);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "tomorrow",
    });
  });

  it("hands back the RAW instant for a far-out dose", () => {
    const now = berlin(2026, 6, 10, 9, 0);
    const next = berlin(2026, 6, 20, 9, 0);
    const label = resolveNextDueDayLabel(next, now, BERLIN);
    expect(label.kind).toBe("date");
    // The formatter applies the profile zone itself, so the instant must
    // arrive unshifted. A pre-shifted value would be an hour or more off.
    expect(label).toEqual({ kind: "date", instant: next });
  });
});

describe("resolveNextDueDayLabel — HOST zone differs from PROFILE zone", () => {
  // The shape of the defect: the label was derived by rendering the instant
  // in the profile zone and re-parsing it as HOST-local, so a value carrying
  // the profile wall clock but tagged with the HOST offset reached the
  // formatter — which then applied the profile offset a SECOND time. The
  // rendered calendar day was wrong for anyone whose two zones differ, and
  // invisible for everyone whose zones agree.
  const HOSTS = ["UTC", "America/New_York", "Australia/Sydney", "Asia/Kolkata"];

  it("returns the untouched instant for the date branch from every host zone", () => {
    const now = berlin(2026, 6, 10, 9, 0);
    const next = berlin(2026, 6, 20, 9, 0);
    for (const host of HOSTS) {
      setHostZone(host);
      const label = resolveNextDueDayLabel(next, now, BERLIN);
      expect(label.kind).toBe("date");
      // Not "within an hour" — byte-identical. Any re-parse through a
      // fabricated wall clock lands somewhere else.
      expect((label as { instant: Date }).instant.getTime()).toBe(
        next.getTime(),
      );
    }
  });

  it("names the same profile day from every host zone", () => {
    const now = berlin(2026, 6, 10, 23, 30);
    const next = berlin(2026, 6, 11, 0, 30);
    for (const host of HOSTS) {
      setHostZone(host);
      expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
        kind: "tomorrow",
      });
    }
  });

  it("keeps a same-profile-day dose on 'today' even when the host clock has already rolled over", () => {
    // 2026-06-10 22:00 Berlin is 2026-06-11 06:00 in Sydney — the host has
    // crossed midnight, the profile has not. The label follows the profile.
    setHostZone("Australia/Sydney");
    const now = berlin(2026, 6, 10, 21, 0);
    const next = berlin(2026, 6, 10, 22, 0);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "today",
    });
  });

  it("reads the weekday in the PROFILE zone, not the host's", () => {
    // 2026-06-14 is a Sunday in Berlin. In Sydney the same instant is
    // already Monday, so a host-derived weekday would name the wrong day.
    setHostZone("Australia/Sydney");
    const now = berlin(2026, 6, 10, 9, 0);
    const next = berlin(2026, 6, 14, 23, 0);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "weekday",
      weekday: 0, // Sunday in Berlin
    });
  });

  it("survives a profile wall clock that lands in the HOST zone's spring-forward gap", () => {
    // New York springs forward 2026-03-08 02:00 → 03:00, so 02:30 does not
    // exist there. Re-parsing the profile wall clock "2026-03-08 02:30" as
    // host-local silently advanced it an hour.
    setHostZone("America/New_York");
    const now = berlin(2026, 3, 8, 2, 30);
    const next = berlin(2026, 3, 18, 2, 30);
    const label = resolveNextDueDayLabel(next, now, BERLIN);
    expect(label).toEqual({ kind: "date", instant: next });
  });
});

describe("resolveNextDueDayLabel — DST transition days", () => {
  it("does not round a 25 h fall-back day's 'tomorrow' into 'today'", () => {
    // Berlin falls back 2026-10-25 (a 25 h local day). An hour-count
    // distance divides 25 h by 24 h and rounds to 1 — which happens to be
    // right here — but the same arithmetic across the 23 h spring-forward
    // day rounds a genuine next-day dose down toward today. Calendar-day
    // indices are immune to both.
    const now = berlin(2026, 10, 25, 8, 0);
    const next = berlin(2026, 10, 26, 8, 0);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "tomorrow",
    });
  });

  it("labels across the 23 h spring-forward day by calendar day", () => {
    // Berlin springs forward 2026-03-29. 2026-03-29 23:30 → 2026-03-30
    // 00:30 is 1 h of wall clock but a genuine calendar-day crossing.
    const now = berlin(2026, 3, 29, 23, 30);
    const next = berlin(2026, 3, 30, 0, 30);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "tomorrow",
    });
  });

  it("still reads 'today' for a later dose on the spring-forward day itself", () => {
    const now = berlin(2026, 3, 29, 1, 30);
    const next = berlin(2026, 3, 29, 20, 0);
    expect(resolveNextDueDayLabel(next, now, BERLIN)).toEqual({
      kind: "today",
    });
  });
});
