/**
 * v1.15.18 — shared cadence-aware band minter.
 *
 * The keystone that builds the correct `SlotBand[]` for EVERY medication
 * cadence, so the read-model + the compliance % + the write/edit paths all
 * consume ONE source of slot windows. These tests pin each cadence the audit
 * called out:
 *
 *   - daily / multi-time      → minute-scale on-time + daily late tail;
 *   - fixed weekdays / N-weeks → day-scale on-time (realised-gap family, NOT
 *                                the field-shape `doseCadenceFamily`);
 *   - rolling (GLP-1)          → retrospective bands anchored AT each intake;
 *   - cyclic                   → off-week slots already filtered out;
 *   - one-shot                 → one WIDE whole-day on-time band, no auto-miss;
 *   - PRN / empty / bad rrule  → [] + `hasExpectedSlots: false`;
 *   - DST day-scale            → ±N calendar days via `localHmAsUtc`, not ±N·DAY;
 *   - multi-schedule           → bands PER SCHEDULE, no cross-schedule clip.
 */
import { describe, expect, it } from "vitest";

import {
  buildBandsForMedication,
  buildBandsForSchedules,
  type BandMinterMedication,
} from "../band-minter";
import {
  type CanonicalSchedule,
  type RecurrenceContext,
} from "../recurrence";
import { localHmAsUtc } from "@/lib/timezone";

const TZ = "Europe/Berlin";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function med(over: Partial<BandMinterMedication> = {}): BandMinterMedication {
  return {
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function schedule(over: Partial<CanonicalSchedule> = {}): CanonicalSchedule {
  return {
    id: "sched-1",
    rrule: null,
    rollingIntervalDays: null,
    timesOfDay: [],
    daysOfWeek: null,
    windowStart: "08:00",
    windowEnd: "08:00",
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...over,
  };
}

function ctxFor(
  m: BandMinterMedication,
  lastIntakeAt: Date | null = null,
): RecurrenceContext {
  return {
    medication: {
      id: m.id,
      startsOn: m.startsOn,
      endsOn: m.endsOn,
      oneShot: m.oneShot,
      createdAt: m.createdAt,
    },
    timeZone: TZ,
    lastIntakeAt,
  };
}

/** Berlin wall-clock HH:mm on the local day implied by `dayRef`. */
function at(dayRef: Date, h: number, m: number): Date {
  return localHmAsUtc(dayRef, TZ, h, m);
}

// ────────────────────────────────────────────────────────────────────
// 1. Daily / multi-time
// ────────────────────────────────────────────────────────────────────

describe("daily multi-time (07:00 / 19:00)", () => {
  const m = med();
  const sched = schedule({ timesOfDay: ["07:00", "19:00"], daysOfWeek: null });
  const day = new Date("2026-06-08T12:00:00Z");
  const out = buildBandsForMedication({
    medication: m,
    schedule: sched,
    ctx: ctxFor(m),
    userTz: TZ,
    range: { from: at(day, 0, 0), to: at(day, 23, 59) },
    now: at(day, 23, 59),
  });

  it("mints one band per time-of-day", () => {
    expect(out.hasExpectedSlots).toBe(true);
    expect(out.bands.map((b) => b.timeOfDay)).toEqual(["07:00", "19:00"]);
  });

  it("classifies as a daily (minute-scale) family", () => {
    expect(out.family).toBe("daily");
  });

  it("uses a minute-scale on-time band (±60min default)", () => {
    const morning = out.bands[0];
    expect(morning.onTimeStart.getTime()).toBe(at(day, 7, 0).getTime() - 60 * MIN);
    expect(morning.onTimeEnd.getTime()).toBe(at(day, 7, 0).getTime() + 60 * MIN);
  });

  it("applies a daily late tail (180min default) capped before the next slot", () => {
    const morning = out.bands[0];
    // 07:00 + 60 on-time + 180 tail = 10:00, well before 19:00 → not capped.
    expect(morning.overdueEnd.getTime()).toBe(at(day, 7, 0).getTime() + (60 + 180) * MIN);
  });

  it("DST-correct anchors: 07:00 Berlin summer is 05:00Z", () => {
    expect(out.bands[0].at.toISOString()).toBe("2026-06-08T05:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Fixed weekdays / every-N-weeks (realised-gap family)
// ────────────────────────────────────────────────────────────────────

describe("fixed weekdays Mon/Thu via legacy daysOfWeek", () => {
  // A Mon/Thu med stored the legacy way. `doseCadenceFamily` would mislabel
  // it daily (±60min). The realised inter-slot gap (3–4 days) must classify
  // it weekly → day-scale on-time.
  const m = med({ startsOn: new Date("2026-06-01T00:00:00Z") });
  const sched = schedule({ daysOfWeek: "1,4", timesOfDay: ["09:00"] });
  // Mon 2026-06-08 .. Sun 2026-06-14 inclusive.
  const from = new Date("2026-06-08T00:00:00Z");
  const to = new Date("2026-06-14T23:59:59Z");
  const out = buildBandsForMedication({
    medication: m,
    schedule: sched,
    ctx: ctxFor(m),
    userTz: TZ,
    range: { from, to },
    now: new Date("2026-06-20T00:00:00Z"),
  });

  it("derives the weekly family from the realised gap, not the field shape", () => {
    expect(out.family).toBe("weekly");
  });

  it("emits the Mon and Thu slots", () => {
    expect(out.bands).toHaveLength(2);
  });

  it("uses a day-scale (±1 day) on-time band", () => {
    const mon = out.bands[0];
    const span = mon.onTimeEnd.getTime() - mon.onTimeStart.getTime();
    // ±1 day on-time → roughly 2 days wide (DST may shift by an hour, allow slop).
    expect(span).toBeGreaterThanOrEqual(2 * DAY - 2 * HOUR);
    expect(span).toBeLessThanOrEqual(2 * DAY + 2 * HOUR);
  });

  it("applies the 4-day late tail (capped before the next slot)", () => {
    const mon = out.bands[0];
    const thu = out.bands[1];
    // Mon on-time-end + 4d would overrun Thu's on-time start (Thu − 1d), so it
    // is capped there.
    expect(mon.overdueEnd.getTime()).toBeLessThanOrEqual(thu.onTimeStart.getTime());
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Rolling / "every N days from last intake" (GLP-1)
// ────────────────────────────────────────────────────────────────────

describe("rolling GLP-1 (every 7 days) — retrospective bands", () => {
  const m = med({ startsOn: new Date("2026-05-01T00:00:00Z") });
  const sched = schedule({
    rollingIntervalDays: 7,
    timesOfDay: ["08:00"],
    windowStart: "08:00",
    windowEnd: "08:00",
  });
  // Three irregular real injections (not exactly 7d apart).
  const shot1 = new Date("2026-05-04T09:12:00Z");
  const shot2 = new Date("2026-05-12T18:40:00Z"); // 8d later
  const shot3 = new Date("2026-05-18T07:55:00Z"); // 6d later
  const intakeInstants = [shot1, shot2, shot3];
  const now = new Date("2026-05-20T12:00:00Z");
  const out = buildBandsForMedication({
    medication: m,
    schedule: sched,
    ctx: ctxFor(m, shot3),
    userTz: TZ,
    range: {
      from: new Date("2026-05-01T00:00:00Z"),
      to: now,
    },
    now,
    intakeInstants,
  });

  it("anchors a band AT each logged injection (not one forward slot)", () => {
    // Three intakes → at least three retrospective bands.
    expect(out.bands.length).toBeGreaterThanOrEqual(3);
  });

  it("each shot's own injection time falls inside its band (on-time)", () => {
    for (const shot of intakeInstants) {
      const owning = out.bands.find(
        (b) => shot.getTime() >= b.onTimeStart.getTime() && shot.getTime() <= b.onTimeEnd.getTime(),
      );
      expect(owning, `shot ${shot.toISOString()} should anchor a band`).toBeDefined();
    }
  });

  it("uses a day-scale (weekly) family for the rolling cadence", () => {
    expect(out.family).toBe("weekly");
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Cyclic (on/off weeks)
// ────────────────────────────────────────────────────────────────────

describe("cyclic (3 weeks on / 1 week off) — off-week slots dropped", () => {
  const m = med({ startsOn: new Date("2026-06-01T00:00:00Z") });
  // Daily within an on-week, 3 on / 1 off; week 4 (2026-06-22..) is off.
  const sched = schedule({
    scheduleType: "CYCLIC",
    cyclicOnWeeks: 3,
    cyclicOffWeeks: 1,
    timesOfDay: ["08:00"],
    daysOfWeek: null,
  });
  // Off-week 4 runs Mon 2026-06-22 .. Sat 2026-06-27; Sunday 06-28 is already
  // the start of the next (Sunday-rooted) on-week, so the range stops Saturday.
  const offWeekFrom = new Date("2026-06-22T00:00:00Z");
  const offWeekTo = new Date("2026-06-27T23:59:59Z");
  const out = buildBandsForMedication({
    medication: m,
    schedule: sched,
    ctx: ctxFor(m),
    userTz: TZ,
    range: { from: offWeekFrom, to: offWeekTo },
    now: new Date("2026-07-10T00:00:00Z"),
  });

  it("mints no bands inside an off week", () => {
    expect(out.bands).toHaveLength(0);
  });

  it("still reports the schedule HAS expected slots (it is scheduled)", () => {
    expect(out.hasExpectedSlots).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. One-shot
// ────────────────────────────────────────────────────────────────────

describe("one-shot — single wide whole-day on-time band", () => {
  const m = med({
    oneShot: true,
    startsOn: new Date("2026-06-08T00:00:00Z"),
  });
  const sched = schedule({ timesOfDay: ["08:00"] });
  const day = new Date("2026-06-08T12:00:00Z");
  const out = buildBandsForMedication({
    medication: m,
    schedule: sched,
    ctx: ctxFor(m),
    userTz: TZ,
    range: { from: at(day, 0, 0), to: at(day, 23, 59) },
    now: at(day, 23, 59),
  });

  it("mints exactly one band", () => {
    expect(out.bands).toHaveLength(1);
  });

  it("the on-time band spans the whole local day", () => {
    const b = out.bands[0];
    // Whole-day on-time → start at local midnight, end at next local midnight.
    expect(b.onTimeStart.getTime()).toBeLessThanOrEqual(at(day, 0, 0).getTime());
    expect(b.onTimeEnd.getTime()).toBeGreaterThanOrEqual(at(day, 23, 59).getTime());
  });

  it("a take any time that day is on-time (a 23:00 take still counts)", () => {
    const b = out.bands[0];
    const late = at(day, 23, 0);
    expect(late.getTime()).toBeGreaterThanOrEqual(b.onTimeStart.getTime());
    expect(late.getTime()).toBeLessThanOrEqual(b.onTimeEnd.getTime());
  });

  it("classifies as a one-shot family", () => {
    expect(out.family).toBe("one_shot");
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. PRN / empty / malformed rrule
// ────────────────────────────────────────────────────────────────────

describe("PRN / empty / malformed → no expected slots", () => {
  const m = med();
  const day = new Date("2026-06-08T12:00:00Z");
  const range = { from: at(day, 0, 0), to: at(day, 23, 59) };

  it("PRN yields [] and hasExpectedSlots=false", () => {
    const out = buildBandsForMedication({
      medication: m,
      schedule: schedule({ scheduleType: "PRN", timesOfDay: ["08:00"] }),
      ctx: ctxFor(m),
      userTz: TZ,
      range,
      now: at(day, 23, 59),
    });
    expect(out.bands).toEqual([]);
    expect(out.hasExpectedSlots).toBe(false);
    expect(out.family).toBe("none");
  });

  it("a malformed rrule yields [] and hasExpectedSlots=false", () => {
    const out = buildBandsForMedication({
      medication: m,
      schedule: schedule({ rrule: "this-is-not-a-valid-rrule" }),
      ctx: ctxFor(m),
      userTz: TZ,
      range,
      now: at(day, 23, 59),
    });
    expect(out.bands).toEqual([]);
    expect(out.hasExpectedSlots).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. DST for day-scale bands
// ────────────────────────────────────────────────────────────────────

describe("DST day-scale bounds via localHmAsUtc (not ±N·DAY_MS)", () => {
  // A weekly slot whose ±1-day window spans the spring-forward transition
  // (Europe/Berlin 2026-03-29 02:00→03:00). The day-scale bound must be the
  // calendar day before/after at the same wall-clock, not a raw 24h subtraction.
  const m = med({ startsOn: new Date("2026-03-01T00:00:00Z") });
  const sched = schedule({
    rrule: "FREQ=WEEKLY;BYDAY=SU",
    timesOfDay: ["09:00"],
  });
  const from = new Date("2026-03-26T00:00:00Z");
  const to = new Date("2026-04-01T23:59:59Z");
  const out = buildBandsForMedication({
    medication: m,
    schedule: sched,
    ctx: ctxFor(m),
    userTz: TZ,
    range: { from, to },
    now: new Date("2026-04-10T00:00:00Z"),
  });

  it("emits the Sunday slot in the DST week", () => {
    expect(out.bands.length).toBeGreaterThanOrEqual(1);
  });

  it("the on-time lower bound is 09:00 the previous calendar day (DST-correct)", () => {
    const b = out.bands[0];
    const anchorParts = b.at; // 2026-03-29 09:00 Berlin
    // The lower bound must read 09:00 Berlin on 2026-03-28, i.e. a calendar-day
    // shift, even though the raw clock distance is 23h across the spring-forward.
    const lower = b.onTimeStart;
    const expectedLower = localHmAsUtc(
      new Date(anchorParts.getTime() - DAY),
      TZ,
      9,
      0,
    );
    expect(lower.toISOString()).toBe(expectedLower.toISOString());
    // And critically NOT the naive ±24h subtraction.
    const naive = new Date(anchorParts.getTime() - DAY);
    expect(lower.getTime()).not.toBe(naive.getTime());
  });
});

// ────────────────────────────────────────────────────────────────────
// 8. Multi-schedule on one med
// ────────────────────────────────────────────────────────────────────

describe("multi-schedule — bands built PER SCHEDULE (no cross-clip)", () => {
  // A daily oral 08:00 + a weekly injection Sunday 08:00 on the same med. If
  // pooled into one buildSlotBands call, the weekly slot's 4-day tail would be
  // clipped by the next daily 08:00 anchor. Per-schedule banding keeps the
  // weekly tail intact.
  const m = med({ startsOn: new Date("2026-06-01T00:00:00Z") });
  const daily = schedule({ id: "daily", timesOfDay: ["08:00"], daysOfWeek: null });
  const weekly = schedule({
    id: "weekly",
    rrule: "FREQ=WEEKLY;BYDAY=SU",
    timesOfDay: ["08:00"],
  });
  const from = new Date("2026-06-07T00:00:00Z"); // Sunday
  const to = new Date("2026-06-13T23:59:59Z");
  const out = buildBandsForSchedules({
    medication: m,
    schedules: [daily, weekly],
    ctx: ctxFor(m),
    userTz: TZ,
    range: { from, to },
    now: new Date("2026-06-20T00:00:00Z"),
  });

  it("returns one group per schedule", () => {
    expect(out).toHaveLength(2);
    expect(out.map((g) => g.scheduleId).sort()).toEqual(["daily", "weekly"]);
  });

  it("the weekly band keeps a multi-day late tail (not clipped by a daily anchor)", () => {
    const weeklyGroup = out.find((g) => g.scheduleId === "weekly");
    expect(weeklyGroup).toBeDefined();
    expect(weeklyGroup!.family).toBe("weekly");
    const sun = weeklyGroup!.bands[0];
    const tailMs = sun.overdueEnd.getTime() - sun.onTimeEnd.getTime();
    // The weekly tail must be on the day scale (>1 day), not clipped to the
    // next daily 08:00 (~24h − on-time) as a pooled call would do.
    expect(tailMs).toBeGreaterThan(DAY);
  });

  it("the daily group keeps minute-scale bands", () => {
    const dailyGroup = out.find((g) => g.scheduleId === "daily");
    expect(dailyGroup!.family).toBe("daily");
    const oneBand = dailyGroup!.bands[0];
    const span = oneBand.onTimeEnd.getTime() - oneBand.onTimeStart.getTime();
    expect(span).toBe(2 * 60 * MIN); // ±60min
  });
});
