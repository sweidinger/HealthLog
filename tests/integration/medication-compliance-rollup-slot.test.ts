/**
 * v1.15.19 — slot-level medication-compliance rollup aggregation.
 *
 * The partial unique index on `(user, medication, scheduled_for, source)`
 * lets two LIVE intake rows share one slot instant when their `source`
 * differs — the production shape: the reminder worker pre-mints a pending
 * REMINDER row on the slot, and a client write that the resolver refused
 * to snap (future-slot guard) used to land a standalone API row on the
 * exact same instant. The rollup previously counted rows (`COUNT(*)`), so
 * a two-dose day with one duplicated slot reported `scheduled=3..4`.
 *
 * These tests pin the corrected semantics on real Postgres:
 *   1. Two live rows on one slot, different source, one taken →
 *      scheduled=1, taken=1.
 *   2. Taken beats skipped inside a slot.
 *   3. The recompute self-corrects historic duplicates with no data
 *      migration (pure SQL, retroactive).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";

const TEST_USER_ID = "user-compliance-rollup-slot";
const TZ = "Europe/Berlin";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let medId = "";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "compliance-rollup-slot",
      email: "compliance-rollup-slot@example.test",
      timezone: TZ,
    },
  });
  const med = await prisma.medication.create({
    data: {
      userId: TEST_USER_ID,
      name: "Ramipril",
      dose: "5mg",
      active: true,
    },
  });
  medId = med.id;
});

// Fixed non-DST-boundary day so the slot instants are deterministic.
// 2026-03-10 07:00 / 19:00 Europe/Berlin (CET, UTC+1).
const SLOT_0700 = new Date("2026-03-10T06:00:00.000Z");
const SLOT_1900 = new Date("2026-03-10T18:00:00.000Z");

async function readRollup() {
  const prisma = getPrismaClient();
  const dayKey = dayKeyForScheduledFor(SLOT_0700, TZ);
  await recomputeMedicationComplianceForDay(TEST_USER_ID, medId, dayKey, TZ);
  return prisma.medicationComplianceRollup.findFirst({
    where: { userId: TEST_USER_ID, medicationId: medId, day: dayKey },
  });
}

describe("medication-compliance rollup — slot-level aggregation (real Postgres)", () => {
  it("counts a cross-source duplicate slot once: scheduled=1, taken=1", async () => {
    const prisma = getPrismaClient();
    // The pending REMINDER row the worker minted on the slot…
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: SLOT_0700,
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });
    // …and the standalone API row a pre-fix client write parked on the
    // exact same instant (the unique index tolerates it: source differs).
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: SLOT_0700,
        takenAt: new Date("2026-03-10T06:02:00.000Z"),
        skipped: false,
        source: "API",
      },
    });

    const rollup = await readRollup();
    expect(rollup).not.toBeNull();
    expect(rollup?.scheduled).toBe(1);
    expect(rollup?.taken).toBe(1);
    expect(rollup?.skipped).toBe(0);
  });

  it("keeps a two-dose day at scheduled=2 when one slot is duplicated", async () => {
    const prisma = getPrismaClient();
    await prisma.medicationIntakeEvent.createMany({
      data: [
        // Duplicated morning slot: pending REMINDER + taken API.
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_0700,
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        },
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_0700,
          takenAt: new Date("2026-03-10T06:01:00.000Z"),
          skipped: false,
          source: "API",
        },
        // Clean evening slot, still pending.
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_1900,
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        },
      ],
    });

    const rollup = await readRollup();
    // Pre-fix this day reported scheduled=3 (row count). Slot-level it is 2.
    expect(rollup?.scheduled).toBe(2);
    expect(rollup?.taken).toBe(1);
    expect(rollup?.skipped).toBe(0);
  });

  it("taken beats skipped inside one slot", async () => {
    const prisma = getPrismaClient();
    await prisma.medicationIntakeEvent.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_0700,
          takenAt: null,
          skipped: true,
          source: "REMINDER",
        },
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_0700,
          takenAt: new Date("2026-03-10T06:05:00.000Z"),
          skipped: false,
          source: "API",
        },
      ],
    });

    const rollup = await readRollup();
    expect(rollup?.scheduled).toBe(1);
    expect(rollup?.taken).toBe(1);
    expect(rollup?.skipped).toBe(0);
  });

  it("counts a purely skipped slot as skipped, not taken", async () => {
    const prisma = getPrismaClient();
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: SLOT_0700,
        takenAt: null,
        skipped: true,
        source: "WEB",
      },
    });

    const rollup = await readRollup();
    expect(rollup?.scheduled).toBe(1);
    expect(rollup?.taken).toBe(0);
    expect(rollup?.skipped).toBe(1);
  });

  it("ignores soft-deleted rows when folding a slot", async () => {
    const prisma = getPrismaClient();
    await prisma.medicationIntakeEvent.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_0700,
          takenAt: new Date("2026-03-10T06:02:00.000Z"),
          skipped: false,
          source: "API",
          deletedAt: new Date(),
        },
        {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: SLOT_0700,
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        },
      ],
    });

    const rollup = await readRollup();
    // The tombstoned taken row must not paint the live pending slot taken.
    expect(rollup?.scheduled).toBe(1);
    expect(rollup?.taken).toBe(0);
    expect(rollup?.skipped).toBe(0);
  });
});
