/**
 * v1.4.25 W19b — inventory persistence helpers.
 *
 * Thin layer on top of Prisma that the route handlers compose. Keeps
 * the state-machine math (pure) separate from the I/O (here), so unit
 * tests on the math don't need a DB.
 *
 * v1.16.10 — the per-intake consumption hook moved to
 * `./consumption.ts` (multi-unit, FEFO, spillover, stamped on the
 * intake event); this module keeps the expire cron and the
 * create-input builder.
 */

import { prisma } from "@/lib/db";
import type { MedicationContainerType } from "@/generated/prisma/client";
import { computeExpiresAt } from "./state-machine";

/**
 * Daily cron pass — flip any IN_USE rows whose 30-day window has
 * elapsed into EXPIRED. Returns the count of transitions for logging.
 *
 * Optionally scoped to a single user — useful for the per-user
 * trigger path. Cron with `userId: null` sweeps every user.
 */
export async function expireStaleInUseItems(input: {
  userId?: string;
  nowMs: number;
}): Promise<number> {
  const { userId, nowMs } = input;
  const now = new Date(nowMs);

  // Candidates: IN_USE rows whose `expiresAt` has lapsed. The
  // selector + state-machine semantics line up here — every row that
  // matches `state = IN_USE AND expiresAt < now` is also a row that
  // `computeInventoryState` would classify EXPIRED (clause 2 or 3),
  // because IN_USE implies `unitsRemaining > 0` (the consumption hook
  // flips an empty container to USED_UP) and the `expiresAt` filter
  // already proves the printed-expiry-or-window deadline has lapsed.
  // EXPIRED rows are already terminal; USED_UP rows are off-window by
  // definition. Use a single `updateMany` instead of one update per
  // row — the daily cron sweep ran N round-trips for nothing.
  const result = await prisma.medicationInventoryItem.updateMany({
    where: {
      state: "IN_USE",
      expiresAt: { lt: now },
      ...(userId ? { userId } : {}),
    },
    data: { state: "EXPIRED" },
  });
  return result.count;
}

/**
 * Helper for the POST /[medId]/inventory route. Composes the
 * Prisma-create with the computed `expiresAt` so the caller doesn't
 * have to re-derive it.
 */
export function buildCreateInventoryInput(input: {
  userId: string;
  medicationId: string;
  unitsTotal: number;
  containerType: MedicationContainerType;
  printedExpiry: Date | null;
  purchasedAt: Date | null;
  notes: string | null;
}) {
  return {
    userId: input.userId,
    medicationId: input.medicationId,
    state: "ACTIVE" as const,
    containerType: input.containerType,
    unitsTotal: input.unitsTotal,
    unitsRemaining: input.unitsTotal,
    firstUseAt: null,
    printedExpiry: input.printedExpiry,
    purchasedAt: input.purchasedAt,
    expiresAt: computeExpiresAt(null, input.printedExpiry),
    notes: input.notes,
  };
}
