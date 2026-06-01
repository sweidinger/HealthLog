/**
 * v1.8.2 — shared slot resolution for the intake write paths.
 *
 * Both `POST /api/medications/[id]/intake` (source WEB) and
 * `POST /api/medications/intake/bulk` (source API) must resolve an
 * incoming dose write to the canonical scheduled-slot instant so the
 * write updates the pending REMINDER row the projector/worker minted
 * rather than inserting a second row that differs only by `source` (and
 * by a sub-minute `scheduledFor` drift). This module loads the
 * medication's schedules + the rolling-anchor `lastIntakeAt` and runs the
 * pure `resolveCanonicalSlotInstant` snap.
 *
 * Returns `null` when the dose does not map to a scheduled slot
 * (PRN / off-slot beyond tolerance / cyclic off-week / no schedules) —
 * the caller's signal to keep the unmodified insert behaviour.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { prisma as defaultPrisma } from "@/lib/db";
import { resolveCanonicalSlotInstant } from "@/lib/medications/scheduling/resolve-slot-instant";
import type { WorkerScheduleRow } from "@/lib/medications/scheduling/worker-helpers";

type PrismaLike = Pick<PrismaClient, "medication" | "medicationIntakeEvent">;

const SCHEDULE_SELECT = {
  id: true,
  windowStart: true,
  windowEnd: true,
  daysOfWeek: true,
  timesOfDay: true,
  reminderGraceMinutes: true,
  rrule: true,
  rollingIntervalDays: true,
  scheduleType: true,
  cyclicOnWeeks: true,
  cyclicOffWeeks: true,
} as const;

const MEDICATION_SELECT = {
  id: true,
  startsOn: true,
  endsOn: true,
  oneShot: true,
  createdAt: true,
  schedules: { select: SCHEDULE_SELECT },
} as const;

export interface ResolveSlotForWriteInput {
  userId: string;
  medicationId: string;
  userTz: string;
  /**
   * The write's `scheduledFor`, or `takenAt` as the fallback when the
   * client omitted `scheduledFor`.
   */
  incoming: Date;
  /** Inject a Prisma client/tx in tests; defaults to the app client. */
  client?: PrismaLike;
}

/**
 * Resolve the canonical scheduled-slot instant for an intake write, or
 * `null` when the dose is unscheduled (PRN / off-slot / no schedules).
 *
 * Loads the medication's schedule rows (and, when any schedule is
 * rolling, the latest non-tombstoned `takenAt` to anchor the next-due
 * computation byte-identically to the projector + worker).
 */
export async function resolveSlotInstantForWrite(
  input: ResolveSlotForWriteInput,
): Promise<Date | null> {
  const client = input.client ?? defaultPrisma;

  const medication = await client.medication.findFirst({
    where: { id: input.medicationId, userId: input.userId },
    select: MEDICATION_SELECT,
  });
  if (!medication || medication.schedules.length === 0) return null;

  // Rolling cadence anchors off the last logged intake — fetch it only
  // when a schedule actually needs it (mirrors the projector's gate).
  let lastIntakeAt: Date | null = null;
  if (medication.schedules.some((s) => s.rollingIntervalDays !== null)) {
    const lastIntake = await client.medicationIntakeEvent.findFirst({
      where: {
        userId: input.userId,
        medicationId: input.medicationId,
        deletedAt: null,
        takenAt: { not: null },
      },
      orderBy: { takenAt: "desc" },
      select: { takenAt: true },
    });
    lastIntakeAt = lastIntake?.takenAt ?? null;
  }

  return resolveCanonicalSlotInstant({
    medication: {
      id: medication.id,
      startsOn: medication.startsOn,
      endsOn: medication.endsOn,
      oneShot: medication.oneShot,
      createdAt: medication.createdAt,
      schedules: medication.schedules as WorkerScheduleRow[],
    },
    userTz: input.userTz,
    incoming: input.incoming,
    lastIntakeAt,
  });
}
