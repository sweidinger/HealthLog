/**
 * v1.16.0 — pin-awareness of the intake-slot dedup pass.
 *
 * Two regressions the v1.15.20 pin/unpin flow could otherwise suffer from
 * the nightly dedup cron:
 *
 *   1. A deliberately UNPINNED ("Zuordnung lösen") or outside-every-band
 *      take is stored as a standalone ad-hoc row with
 *      `scheduledFor === takenAt`. The dedup's canonical-instant resolver
 *      still uses the legacy ± half-window snap, which is WIDER than the
 *      band model — without the guard the cron would re-merge the row into
 *      the nearest slot's cluster, silently reverting the user's binding
 *      decision (and, when the slot row is also a take, soft-deleting one
 *      of two real dose records).
 *
 *   2. A USER_PIN row shares its slot anchor with a sibling row (cross-
 *      source race). The winner pick must prefer the pinned take — the pin
 *      IS the dose of record for its slot — instead of letting the
 *      `syncVersion` tie-break soft-delete the user's deliberate decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));

import { dedupeUserIntakeSlots } from "../intake-slot-dedup";
import { prisma } from "@/lib/db";

const TZ = "Europe/Berlin";

// A daily 07:00 / 19:00 SCHEDULED med — same shape as the isolation test.
const SCHEDULE = {
  id: "s1",
  windowStart: "07:00",
  windowEnd: "07:00",
  daysOfWeek: null,
  timesOfDay: ["07:00", "19:00"],
  reminderGraceMinutes: null,
  rrule: null,
  rollingIntervalDays: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
};

const MED = {
  id: "med-1",
  userId: "u1",
  startsOn: null,
  endsOn: null,
  oneShot: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  schedules: [SCHEDULE],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timezone: TZ,
  } as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([MED] as never);
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.updateMany).mockResolvedValue({
    count: 1,
  } as never);
  vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue(
    {} as never,
  );
});

describe("dedupeUserIntakeSlots — pin-awareness (v1.16.0)", () => {
  it("never re-merges a deliberate ad-hoc take (scheduledFor === takenAt) into a slot cluster", async () => {
    // 07:00 CEST = 05:00Z. The pending REMINDER row sits on the anchor;
    // the unpinned take sits 40 min later — inside the legacy snap
    // tolerance, outside the user's deliberate ad-hoc decision.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        id: "r-07-rem",
        medicationId: "med-1",
        scheduledFor: new Date("2026-06-15T05:00:00.000Z"),
        takenAt: null,
        skipped: false,
        syncVersion: 0,
        createdAt: new Date("2026-06-15T00:00:00Z"),
        attributionSource: "AUTO",
      },
      {
        id: "r-07-adhoc",
        medicationId: "med-1",
        scheduledFor: new Date("2026-06-15T05:40:00.000Z"),
        takenAt: new Date("2026-06-15T05:40:00.000Z"),
        skipped: false,
        syncVersion: 3,
        createdAt: new Date("2026-06-15T05:40:00Z"),
        attributionSource: "AUTO",
      },
    ] as never);

    const summary = await dedupeUserIntakeSlots("u1");

    // The ad-hoc row never joins the 05:00 cluster → the slot holds one
    // row → nothing collapses, nothing is soft-deleted or normalised.
    expect(summary.slotsCollapsed).toBe(0);
    expect(summary.rowsSoftDeleted).toBe(0);
    expect(prisma.medicationIntakeEvent.updateMany).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("keeps the USER_PIN row as the slot winner over a higher-syncVersion sibling take", async () => {
    // Both rows sit on the 05:00Z anchor (cross-source race shape). The
    // sibling AUTO take has the higher syncVersion — without the pin rung
    // it would win the tie-break and the user's pin would be tombstoned.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        id: "r-07-pin",
        medicationId: "med-1",
        scheduledFor: new Date("2026-06-15T05:00:00.000Z"),
        takenAt: new Date("2026-06-15T09:30:00.000Z"),
        skipped: false,
        syncVersion: 1,
        createdAt: new Date("2026-06-15T05:00:00Z"),
        attributionSource: "USER_PIN",
      },
      {
        id: "r-07-auto",
        medicationId: "med-1",
        scheduledFor: new Date("2026-06-15T05:00:00.000Z"),
        takenAt: new Date("2026-06-15T05:05:00.000Z"),
        skipped: false,
        syncVersion: 7,
        createdAt: new Date("2026-06-15T05:01:00Z"),
        attributionSource: "AUTO",
      },
    ] as never);

    const summary = await dedupeUserIntakeSlots("u1");

    expect(summary.slotsCollapsed).toBe(1);
    // The AUTO sibling is the loser; the pinned row survives.
    const updateManyArg = vi.mocked(prisma.medicationIntakeEvent.updateMany)
      .mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(updateManyArg.where.id.in).toEqual(["r-07-auto"]);
  });
});
