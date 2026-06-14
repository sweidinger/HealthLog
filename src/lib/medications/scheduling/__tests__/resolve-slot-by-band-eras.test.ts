/**
 * v1.16.13 — schedule-era correctness for the WRITE/EDIT slot resolution seam.
 *
 * `resolveSlotForWriteByBand` (and `resolveForcedSlotForWrite`) load the
 * medication via `loadAttributeMedication` and run the shared band attributor.
 * The loader MUST thread the archived `scheduleRevisions` into the attributor
 * projection — otherwise a historical intake edit attributes against the LIVE
 * schedule instead of the era that was valid at the dose's `takenAt`, silently
 * misfiling old doses after a times edit.
 *
 * The read side (dose-history / compliance) already threads revisions; this
 * pins the write side to the same era resolution.
 */
import { describe, expect, it, vi } from "vitest";

import {
  resolveSlotForWriteByBand,
  resolveForcedSlotForWrite,
} from "../slot-upsert";

const TZ = "Europe/Berlin";

const createdAt = new Date("2026-05-01T08:00:00.000Z");
// The schedule was replaced on 31 May at 10:00 UTC (12:00 Berlin):
// old era ran 07:00 / 19:00 Berlin; the live schedule runs 09:00 / 21:00.
const replaceAt = new Date("2026-05-31T10:00:00.000Z");

const liveSchedule = {
  id: "live-1",
  windowStart: "09:00",
  windowEnd: "21:00",
  daysOfWeek: null,
  timesOfDay: ["09:00", "21:00"],
  reminderGraceMinutes: null,
  rrule: "FREQ=DAILY",
  rollingIntervalDays: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
  doseWindows: null,
};

const oldEraRevision = {
  id: "rev-1",
  validFrom: createdAt,
  validUntil: replaceAt,
  supersededByRevisionId: null,
  payload: [
    {
      timesOfDay: ["07:00", "19:00"],
      windowStart: "07:00",
      windowEnd: "19:00",
      daysOfWeek: null,
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      scheduleType: "SCHEDULED",
      cyclicOnWeeks: null,
      cyclicOffWeeks: null,
      doseWindows: null,
      label: null,
      dose: null,
      reminderGraceMinutes: null,
    },
  ],
};

/**
 * Fake Prisma client whose `medication.findFirst` returns a med carrying the
 * archived old-era revision exactly as `MEDICATION_SELECT` would, plus the
 * live (post-replace) schedules.
 */
function makeClient(withRevisions: boolean) {
  return {
    medication: {
      findFirst: vi.fn(async () => ({
        id: "med-1",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt,
        schedules: [liveSchedule],
        scheduleRevisions: withRevisions ? [oldEraRevision] : [],
      })),
    },
    medicationIntakeEvent: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
  };
}

type BandClient = Parameters<typeof resolveSlotForWriteByBand>[0]["client"];

describe("resolveSlotForWriteByBand — schedule eras", () => {
  it("attributes a historical edit against the era live at the takenAt", async () => {
    const client = makeClient(true) as unknown as BandClient;
    // Editing a take back to 25 May 07:10 Berlin (05:10 UTC) — old era's
    // 07:00 slot, NOT the live 09:00 slot.
    const takenAt = new Date("2026-05-25T05:10:00.000Z");
    const out = await resolveSlotForWriteByBand({
      userId: "u1",
      medicationId: "med-1",
      userTz: TZ,
      takenAt,
      now: new Date("2026-06-05T00:00:00.000Z"),
      client,
    });
    expect(out.slotInstant?.toISOString()).toBe("2026-05-25T05:00:00.000Z");
    expect(out.status).toBe("on_time");
  });

  it("without revisions the same instant does NOT snap to the old 07:00 slot", async () => {
    const client = makeClient(false) as unknown as BandClient;
    const takenAt = new Date("2026-05-25T05:10:00.000Z");
    const out = await resolveSlotForWriteByBand({
      userId: "u1",
      medicationId: "med-1",
      userTz: TZ,
      takenAt,
      now: new Date("2026-06-05T00:00:00.000Z"),
      client,
    });
    // Live schedule (09:00 / 21:00) would not place a 07:10 take on a 07:00
    // anchor — proves the revision is what fixes the attribution.
    expect(out.slotInstant?.toISOString()).not.toBe(
      "2026-05-25T05:00:00.000Z",
    );
  });
});

describe("resolveForcedSlotForWrite — schedule eras", () => {
  it("validates an old-era slot anchor against the era live then", async () => {
    const client = makeClient(true) as unknown as BandClient;
    // Pin onto the old era's 07:00 Berlin slot on 25 May (05:00 UTC).
    const slotInstant = new Date("2026-05-25T05:00:00.000Z");
    const resolved = await resolveForcedSlotForWrite({
      userId: "u1",
      medicationId: "med-1",
      userTz: TZ,
      slotInstant,
      now: new Date("2026-06-05T00:00:00.000Z"),
      client,
    });
    expect(resolved?.toISOString()).toBe("2026-05-25T05:00:00.000Z");
  });

  it("rejects the old-era anchor when revisions are dropped", async () => {
    const client = makeClient(false) as unknown as BandClient;
    const slotInstant = new Date("2026-05-25T05:00:00.000Z");
    const resolved = await resolveForcedSlotForWrite({
      userId: "u1",
      medicationId: "med-1",
      userTz: TZ,
      slotInstant,
      now: new Date("2026-06-05T00:00:00.000Z"),
      client,
    });
    // The live schedule mints no 07:00 anchor, so the pin can't validate.
    expect(resolved).toBeNull();
  });
});
