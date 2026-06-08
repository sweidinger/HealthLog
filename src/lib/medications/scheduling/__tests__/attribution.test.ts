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
import { localHmAsUtc } from "@/lib/timezone";

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
    // The exact case Marc reported: an 11:29 take must NOT show as the 07:00 slot.
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

  it("a take at 17:30 is ad-hoc (past the 07:00 tail, before the 19:00 window)", () => {
    expect(attributeIntakeToSlot(at(day, 17, 30), bands)).toBeNull();
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
    // Marc's lever: a real morning window of 07:00–12:00 (not a ±60 point)
    // means his habitual ~11:00 intake counts as on-time, not ad-hoc.
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
