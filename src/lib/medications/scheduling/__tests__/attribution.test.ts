/**
 * v1.15.18 — window-band intake→slot attribution.
 *
 * Replaces the wide nearest-neighbour matchers (the ±6h write-time snap in
 * `resolve-slot-instant.ts` and the ±12h/half-gap read-time radius in
 * `cadence.ts pairDoses`) that forced an irregular real intake onto the
 * nearest configured slot — producing absurd rows like "07:00 dose taken
 * 15:46". Attribution is now pure band membership:
 *
 *   - intake ∈ [onTimeStart, onTimeEnd]            → on_time (this slot)
 *   - intake ∈ (onTimeEnd, overdueEnd]             → late    (this slot)
 *   - otherwise                                    → null    (ad-hoc)
 *
 * `overdueEnd` is the late tail past `onTimeEnd`, capped so it can never
 * bleed into the next slot's on-time start (adjacent slots never both claim
 * one intake). The on-time band IS the user's configurable dose window; the
 * default point window is ±60min on-time + a 180min late tail
 * (`DOSE_WINDOW_DEFAULTS`). All math is in instants, DST handled by the
 * caller minting the band bounds via `localHmAsUtc`.
 */
import { describe, expect, it } from "vitest";

import {
  buildSlotBands,
  attributeIntakeToSlot,
  type SlotWindowInput,
} from "../attribution";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TZ = "Europe/Berlin";
const MIN = 60_000;

/** A point-time slot with a symmetric on-time half-width + a late tail. */
function pointSlot(
  at: Date,
  timeOfDay: string,
  onTimeHalfMin = 60,
  lateGraceMin = 180,
): SlotWindowInput {
  return {
    at,
    timeOfDay,
    onTimeStart: new Date(at.getTime() - onTimeHalfMin * MIN),
    onTimeEnd: new Date(at.getTime() + onTimeHalfMin * MIN),
    lateGraceMs: lateGraceMin * MIN,
  };
}

/** {07:00, 19:00} Europe/Berlin for the local day implied by `dayRef`. */
function ramiprilSlots(dayRef: Date): SlotWindowInput[] {
  return [
    pointSlot(localHmAsUtc(dayRef, TZ, 7, 0), "07:00"),
    pointSlot(localHmAsUtc(dayRef, TZ, 19, 0), "19:00"),
  ];
}

/** Berlin wall-clock HH:mm on the same local day → instant. */
function at(dayRef: Date, h: number, m: number): Date {
  return localHmAsUtc(dayRef, TZ, h, m);
}

describe("attributeIntakeToSlot — summer (CEST)", () => {
  const day = new Date("2026-06-08T12:00:00Z");
  const bands = buildSlotBands(ramiprilSlots(day));

  it("07:00 dose taken 07:00 is on_time for the 07:00 slot", () => {
    const r = attributeIntakeToSlot(at(day, 7, 0), bands);
    expect(r?.band.timeOfDay).toBe("07:00");
    expect(r?.status).toBe("on_time");
  });

  it("07:00 dose taken 08:30 is late for the 07:00 slot (inside the tail)", () => {
    const r = attributeIntakeToSlot(at(day, 8, 30), bands);
    expect(r?.band.timeOfDay).toBe("07:00");
    expect(r?.status).toBe("late");
  });

  it("a take at 11:29 is ad-hoc (past the 07:00 tail, before the 19:00 window)", () => {
    // The exact case the maintainer reported: an 11:29 take must NOT show as the 07:00 slot.
    expect(attributeIntakeToSlot(at(day, 11, 29), bands)).toBeNull();
  });

  it("a midday take at 13:02 is ad-hoc (not snapped onto 19:00)", () => {
    expect(attributeIntakeToSlot(at(day, 13, 2), bands)).toBeNull();
  });

  it("19:00 dose taken 19:00 is on_time for the 19:00 slot", () => {
    const r = attributeIntakeToSlot(at(day, 19, 0), bands);
    expect(r?.band.timeOfDay).toBe("19:00");
    expect(r?.status).toBe("on_time");
  });

  it("an early evening take at 18:30 is on_time for the 19:00 slot", () => {
    const r = attributeIntakeToSlot(at(day, 18, 30), bands);
    expect(r?.band.timeOfDay).toBe("19:00");
    expect(r?.status).toBe("on_time");
  });

  it("a take at 17:30 credits the 19:00 slot through the bounded early grace (v1.16.9)", () => {
    // 30 min before the 18:00 on-time start — inside the 60-min early
    // grace, so a slightly-early take credits its slot instead of
    // orphaning ad-hoc while the slot later reads missed.
    const r = attributeIntakeToSlot(at(day, 17, 30), bands);
    expect(r?.band.timeOfDay).toBe("19:00");
    expect(r?.status).toBe("on_time");
  });

  it("a take at 16:30 stays ad-hoc (beyond the 60-min early grace)", () => {
    expect(attributeIntakeToSlot(at(day, 16, 30), bands)).toBeNull();
  });
});

describe("attributeIntakeToSlot — winter (CET, DST-robust)", () => {
  const day = new Date("2026-01-15T12:00:00Z");
  const bands = buildSlotBands(ramiprilSlots(day));

  it("07:00 dose taken 07:00 is on_time in winter too", () => {
    const r = attributeIntakeToSlot(at(day, 7, 0), bands);
    expect(r?.band.timeOfDay).toBe("07:00");
    expect(r?.status).toBe("on_time");
  });

  it("11:29 take is ad-hoc in winter too", () => {
    expect(attributeIntakeToSlot(at(day, 11, 29), bands)).toBeNull();
  });

  it("the 07:00 slot's true instant is 06:00Z in winter (CET = UTC+1)", () => {
    expect(bands[0].at.toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });
});

describe("buildSlotBands — late tail never bleeds into the next slot", () => {
  // Two close slots 08:00 / 12:00 with a generous 180min tail: 08:00's tail
  // (08:00+60+180 = 11:00) is capped at 12:00's on-time start (11:00). With
  // an even larger tail the cap binds.
  const day = new Date("2026-06-08T12:00:00Z");
  const slots: SlotWindowInput[] = [
    pointSlot(localHmAsUtc(day, TZ, 8, 0), "08:00", 60, 600), // 10h tail
    pointSlot(localHmAsUtc(day, TZ, 12, 0), "12:00", 60, 180),
  ];
  const bands = buildSlotBands(slots);

  it("caps the 08:00 overdueEnd at the 12:00 on-time start (11:00)", () => {
    expect(bands[0].overdueEnd.toISOString()).toBe(
      bands[1].onTimeStart.toISOString(),
    );
  });

  it("a take at 11:30 belongs to the 12:00 slot, not the over-long 08:00 tail", () => {
    const r = attributeIntakeToSlot(at(day, 11, 30), bands);
    expect(r?.band.timeOfDay).toBe("12:00");
    expect(r?.status).toBe("on_time");
  });
});

describe("attributeIntakeToSlot — configurable window widens on-time", () => {
  const day = new Date("2026-06-08T12:00:00Z");

  it("an explicit 07:00–12:00 window makes an 11:29 take on_time for that dose", () => {
    // The maintainer's lever: a real morning window of 07:00–12:00 (not a ±60 point)
    // means their habitual ~11:00 intake counts as on-time, not ad-hoc.
    const slots: SlotWindowInput[] = [
      {
        at: localHmAsUtc(day, TZ, 7, 0),
        timeOfDay: "07:00",
        onTimeStart: localHmAsUtc(day, TZ, 7, 0),
        onTimeEnd: localHmAsUtc(day, TZ, 12, 0),
        lateGraceMs: 180 * MIN,
      },
      pointSlot(localHmAsUtc(day, TZ, 19, 0), "19:00"),
    ];
    const bands = buildSlotBands(slots);
    const r = attributeIntakeToSlot(at(day, 11, 29), bands);
    expect(r?.band.timeOfDay).toBe("07:00");
    expect(r?.status).toBe("on_time");
  });
});

/**
 * v1.16.9 — bounded early grace ahead of the on-time band.
 *
 * A window configured to start AT the dose time ("09:00–10:00") refused
 * an 08:42 take: it orphaned ad-hoc and the slot read missed. Takes up to
 * 60 min before `onTimeStart` now credit the slot; the reach is capped at
 * the previous slot's `overdueEnd` so a take inside the prior dose's late
 * tail is never re-claimed.
 */
describe("attributeIntakeToSlot — bounded early grace (v1.16.9)", () => {
  const day = new Date("2026-06-08T12:00:00Z");

  function nineToTenWindow(): SlotWindowInput {
    return {
      at: localHmAsUtc(day, TZ, 9, 0),
      timeOfDay: "09:00",
      onTimeStart: localHmAsUtc(day, TZ, 9, 0),
      onTimeEnd: localHmAsUtc(day, TZ, 10, 0),
      lateGraceMs: 180 * MIN,
    };
  }

  it("an 08:42 take credits the 09:00 slot whose window starts AT 09:00", () => {
    const bands = buildSlotBands([nineToTenWindow()]);
    const r = attributeIntakeToSlot(at(day, 8, 42), bands);
    expect(r?.band.timeOfDay).toBe("09:00");
    expect(r?.status).toBe("on_time");
  });

  it("a take more than 60 min before the window start stays ad-hoc", () => {
    const bands = buildSlotBands([nineToTenWindow()]);
    expect(attributeIntakeToSlot(at(day, 7, 55), bands)).toBeNull();
  });

  it("the early grace never crosses into the previous slot's band", () => {
    // 06:00 slot with a long late tail reaching to 09:00 (capped exactly
    // at the 09:00 window start) + the 09:00–10:00 window. A take at
    // 08:42 sits inside the 06:00 slot's tail — it must stay attributed
    // LATE to the 06:00 slot, never early-claimed by the 09:00 slot.
    const slots: SlotWindowInput[] = [
      {
        at: localHmAsUtc(day, TZ, 6, 0),
        timeOfDay: "06:00",
        onTimeStart: localHmAsUtc(day, TZ, 5, 30),
        onTimeEnd: localHmAsUtc(day, TZ, 6, 30),
        lateGraceMs: 600 * MIN, // capped at the next window's start
      },
      nineToTenWindow(),
    ];
    const bands = buildSlotBands(slots);
    // The cap binds: the 09:00 band's early reach starts where the 06:00
    // tail ends.
    expect(bands[1].earlyStart.toISOString()).toBe(
      bands[0].overdueEnd.toISOString(),
    );
    const r = attributeIntakeToSlot(at(day, 8, 42), bands);
    expect(r?.band.timeOfDay).toBe("06:00");
    expect(r?.status).toBe("late");
  });

  it("isLastIntakeInBand suppression mirrors the grace (no take-now after an 08:42 take)", () => {
    // Covered at the card level: see window-status — this pins the band
    // shape the suppression relies on (earlyStart <= onTimeStart always).
    const bands = buildSlotBands([nineToTenWindow()]);
    expect(bands[0].earlyStart.getTime()).toBeLessThanOrEqual(
      bands[0].onTimeStart.getTime(),
    );
  });
});
