/**
 * v1.17.1 — server-authoritative next-due computation for Vorsorge
 * reminders. Pins the rolling + rrule cadence contract that web ↔ iOS
 * both read off `nextDueAt`.
 */
import { describe, it, expect } from "vitest";

import {
  computeReminderNextDueAt,
  type ReminderScheduleInput,
} from "../scheduling";

const TZ = "Europe/Berlin";

function base(overrides: Partial<ReminderScheduleInput>): ReminderScheduleInput {
  return {
    intervalDays: null,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    lastSatisfiedAt: null,
    createdAt: new Date("2026-06-01T08:00:00Z"),
    ...overrides,
  };
}

describe("computeReminderNextDueAt", () => {
  it("returns null when neither intervalDays nor rrule is set", () => {
    const now = new Date("2026-06-10T07:00:00Z");
    expect(computeReminderNextDueAt(base({}), TZ, now)).toBeNull();
  });

  it("rolling, never satisfied: first due AT the anchor day notify-hour", () => {
    // Anchor 2026-06-10; notifyHour 9 local (Berlin = UTC+2 in June → 07:00Z).
    const reminder = base({
      intervalDays: 7,
      anchorDate: new Date("2026-06-10T00:00:00Z"),
      notifyHour: 9,
      createdAt: new Date("2026-06-09T00:00:00Z"),
    });
    // "after" before the anchor → the first due is the anchor's slot.
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-09T12:00:00Z"),
    );
    expect(due).not.toBeNull();
    // 09:00 Berlin on 2026-06-10 == 07:00Z (DST).
    expect(due!.toISOString()).toBe("2026-06-10T07:00:00.000Z");
  });

  it("rolling, satisfied: next due is lastSatisfiedAt + N days at notify-hour", () => {
    const reminder = base({
      intervalDays: 7,
      lastSatisfiedAt: new Date("2026-06-10T15:00:00Z"),
      notifyHour: 9,
    });
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-10T16:00:00Z"),
    );
    expect(due).not.toBeNull();
    // 7 days after the satisfy → 2026-06-17, slot at 09:00 Berlin = 07:00Z.
    expect(due!.toISOString()).toBe("2026-06-17T07:00:00.000Z");
  });

  it("rolling honours the interval length (30 days)", () => {
    const reminder = base({
      intervalDays: 30,
      lastSatisfiedAt: new Date("2026-06-01T15:00:00Z"),
      notifyHour: 9,
    });
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(due!.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });

  it("rrule annual: walks to the next yearly occurrence after now", () => {
    // FREQ=YEARLY anchored on the createdAt day (2026-06-01).
    const reminder = base({
      rrule: "FREQ=YEARLY",
      anchorDate: new Date("2026-06-01T00:00:00Z"),
      createdAt: new Date("2026-06-01T00:00:00Z"),
      notifyHour: 9,
    });
    // After the 2026 occurrence → expect the 2027 one.
    const due = computeReminderNextDueAt(
      reminder,
      TZ,
      new Date("2026-06-02T00:00:00Z"),
    );
    expect(due).not.toBeNull();
    expect(due!.getUTCFullYear()).toBe(2027);
    expect(due!.getUTCMonth()).toBe(5); // June (0-indexed)
  });
});
