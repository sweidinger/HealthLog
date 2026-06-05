import { describe, expect, it } from "vitest";

import { resolveDisplayedSlotInstant } from "@/components/medications/card-parts/displayed-slot-instant";

/**
 * v1.12.3 — the card-side slot resolver that closes the
 * "morning auto-taken" intake bug. The medication card shows ONE
 * actionable dose; its "Genommen" button must record THAT dose, not let
 * the server snap "now" to the nearest slot. This resolver derives the
 * displayed dose's slot instant from the card's current-window status (the
 * open/overdue window's `windowStart` today) or the server's `nextDueAt`.
 */
describe("resolveDisplayedSlotInstant", () => {
  // A point in the late morning, Berlin (CEST = UTC+2 in June). 09:00 Berlin.
  const morningNow = new Date("2026-06-05T07:00:00.000Z");

  it("targets the open window's slot on today's calendar day", () => {
    const slot = resolveDisplayedSlotInstant({
      currentWindowStatus: {
        status: "in_window",
        schedule: { windowStart: "07:00", windowEnd: "19:00" },
      },
      nextDueAt: null,
      now: morningNow,
      timeZone: "Europe/Berlin",
    });
    expect(slot).not.toBeNull();
    // 07:00 Berlin on 2026-06-05 is 05:00 UTC (CEST = +2).
    expect(slot!.toISOString()).toBe("2026-06-05T05:00:00.000Z");
  });

  it("targets the morning window when the card surfaces the morning dose, regardless of a later wall-clock", () => {
    // Even if the user taps in the afternoon, the morning window's slot is
    // what the card surfaced (e.g. an overdue 07:00 dose), so the resolved
    // instant must still be the 07:00 slot — NOT a now-snap.
    const afternoonNow = new Date("2026-06-05T13:00:00.000Z"); // 15:00 Berlin
    const slot = resolveDisplayedSlotInstant({
      currentWindowStatus: {
        status: "very_late",
        schedule: { windowStart: "07:00", windowEnd: "08:00" },
      },
      nextDueAt: null,
      now: afternoonNow,
      timeZone: "Europe/Berlin",
    });
    expect(slot!.toISOString()).toBe("2026-06-05T05:00:00.000Z");
  });

  it("targets the evening window's slot when the card surfaces the evening dose", () => {
    const eveningNow = new Date("2026-06-05T17:00:00.000Z"); // 19:00 Berlin
    const slot = resolveDisplayedSlotInstant({
      currentWindowStatus: {
        status: "in_window",
        schedule: { windowStart: "19:00", windowEnd: "20:00" },
      },
      nextDueAt: null,
      now: eveningNow,
      timeZone: "Europe/Berlin",
    });
    // 19:00 Berlin on 2026-06-05 is 17:00 UTC.
    expect(slot!.toISOString()).toBe("2026-06-05T17:00:00.000Z");
  });

  it("falls back to the server's next-due instant when no window is currently actionable", () => {
    const nextDueAt = "2026-06-06T05:00:00.000Z";
    const slot = resolveDisplayedSlotInstant({
      currentWindowStatus: { status: null, schedule: null },
      nextDueAt,
      now: morningNow,
    });
    expect(slot!.toISOString()).toBe(nextDueAt);
  });

  it("prefers the open window over next-due (the user acts on the dose in front of them)", () => {
    const slot = resolveDisplayedSlotInstant({
      currentWindowStatus: {
        status: "in_window",
        schedule: { windowStart: "07:00", windowEnd: "19:00" },
      },
      nextDueAt: "2026-06-06T05:00:00.000Z",
      now: morningNow,
      timeZone: "Europe/Berlin",
    });
    expect(slot!.toISOString()).toBe("2026-06-05T05:00:00.000Z");
  });

  it("returns null for a PRN dose (no current window, no next-due) so the server keeps the now-snap path", () => {
    expect(
      resolveDisplayedSlotInstant({
        currentWindowStatus: { status: null, schedule: null },
        nextDueAt: null,
        now: morningNow,
      }),
    ).toBeNull();
  });

  it("returns null on a malformed next-due rather than an Invalid Date", () => {
    expect(
      resolveDisplayedSlotInstant({
        currentWindowStatus: { status: null, schedule: null },
        nextDueAt: "not-a-date",
        now: morningNow,
      }),
    ).toBeNull();
  });

  it("handles a standard-time (CET = UTC+1) winter slot", () => {
    const winterNow = new Date("2026-01-15T06:00:00.000Z"); // 07:00 Berlin (CET)
    const slot = resolveDisplayedSlotInstant({
      currentWindowStatus: {
        status: "in_window",
        schedule: { windowStart: "07:00", windowEnd: "19:00" },
      },
      nextDueAt: null,
      now: winterNow,
      timeZone: "Europe/Berlin",
    });
    // 07:00 Berlin on 2026-01-15 is 06:00 UTC (CET = +1).
    expect(slot!.toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });
});
