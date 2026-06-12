/**
 * v1.16.10 — per-intake inventory consumption + restore.
 *
 * The single write path between intake events and inventory items.
 * Every seam that flips an intake event to TAKEN calls
 * `consumeForIntake`; every seam that takes a row OUT of taken
 * (skip toggle, edit, delete, bulk delete, slot-dedup tombstone)
 * calls `restoreForIntake`. No other module may write
 * `medicationInventoryItem` rows outside the inventory CRUD routes —
 * a convention test pins that.
 *
 * Exactly-once semantics hang off the consumption STAMP — the
 * `MedicationIntakeEvent.inventoryConsumption` Json column holding
 * `[{itemId, units}]`:
 *
 *   - `consumeForIntake` is a no-op on a stamped row, so idempotent
 *     replays (iOS sync, Telegram redelivery, double taps) can call it
 *     freely and the stock only ever moves once per taken event.
 *   - `restoreForIntake` refunds exactly what the stamp recorded and
 *     clears it, so a later re-take consumes afresh. The stamp freezes
 *     history: editing `Medication.unitsPerDose` after the fact never
 *     changes what an already-taken dose consumed or refunds.
 *
 * Consumption is in UNITS (`Medication.unitsPerDose` per dose), pulled
 * from the open container first, then FEFO over unopened stock with
 * auto-open, spilling across containers, flooring at zero when the
 * tracked stock runs out (partial stamp — never negative, never an
 * error).
 *
 * Both functions are best-effort and NEVER throw: a failure annotates
 * (`medication.inventory.consume_error` / `.restore_error`) and
 * returns — the intake write is the source of truth, the inventory is
 * an opt-in companion that must never block a dose record.
 */

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { annotate } from "@/lib/logging/context";
import {
  computeExpiresAt,
  computeInventoryState,
} from "./state-machine";

/** The Prisma surface the consumption hook needs. A bare transaction
 *  client satisfies it; the base client additionally carries
 *  `$transaction`, which the hook uses to keep the item updates and
 *  the stamp write atomic. */
type ConsumptionClient = Pick<
  PrismaClient,
  "medication" | "medicationIntakeEvent" | "medicationInventoryItem"
> &
  Partial<Pick<PrismaClient, "$transaction">>;

type TxClient = Pick<
  PrismaClient,
  "medication" | "medicationIntakeEvent" | "medicationInventoryItem"
>;

/** One consumed slice of the stamp: `units` taken from `itemId`. */
export interface InventoryConsumptionEntry {
  itemId: string;
  units: number;
}

/**
 * Run `fn` atomically. When the caller hands us the base client we
 * open an interactive transaction; when it hands us a transaction
 * client (no `$transaction` on it) the caller's transaction already
 * provides the atomicity and we run inline.
 */
async function runAtomically<T>(
  client: ConsumptionClient,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (typeof client.$transaction === "function") {
    return client.$transaction((tx) => fn(tx as TxClient));
  }
  return fn(client);
}

/** Parse a stamp column value defensively — a malformed stamp refunds
 *  nothing rather than throwing. */
function parseStamp(value: Prisma.JsonValue | null): InventoryConsumptionEntry[] | null {
  if (value === null || !Array.isArray(value)) return null;
  const entries: InventoryConsumptionEntry[] = [];
  for (const raw of value) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      typeof (raw as { itemId?: unknown }).itemId === "string" &&
      typeof (raw as { units?: unknown }).units === "number" &&
      Number.isFinite((raw as { units: number }).units) &&
      (raw as { units: number }).units > 0
    ) {
      entries.push({
        itemId: (raw as { itemId: string }).itemId,
        units: Math.floor((raw as { units: number }).units),
      });
    }
  }
  return entries;
}

/**
 * Consume the medication's `unitsPerDose` units for one taken intake
 * event and stamp the event with what was consumed.
 *
 * No-op unless the event row is live (`deletedAt: null`), taken
 * (`takenAt` set), non-skipped, and UNSTAMPED — the stamp is the
 * exactly-once gate, so replays and re-posts never double-decrement.
 *
 * Container selection:
 *   1. the open container — IN_USE with `unitsRemaining > 0`, earliest
 *      `expiresAt` first (createdAt tiebreak);
 *   2. then FEFO over unopened ACTIVE stock — `printedExpiry` asc with
 *      nulls last, then `purchasedAt` asc (nulls last), then
 *      `createdAt` asc. Pulling from an ACTIVE container auto-opens it
 *      (`firstUseAt = intakeAt`, state via the state machine — a
 *      backdated intake can land it straight in EXPIRED when the
 *      30-day window has already lapsed; that is correct).
 *
 * Consumption spills: when the current container holds fewer units
 * than still owed, it drains to zero and the next container covers the
 * rest. When the tracked stock runs out the consumption floors at
 * zero overall — the stamp records the partial amount, no error, no
 * negative counts.
 */
export async function consumeForIntake(input: {
  client: ConsumptionClient;
  userId: string;
  medicationId: string;
  eventId: string;
  intakeAt: Date;
}): Promise<void> {
  const { client, userId, medicationId, eventId, intakeAt } = input;
  try {
    await runAtomically(client, async (tx) => {
      const event = await tx.medicationIntakeEvent.findFirst({
        where: { id: eventId, userId },
        select: {
          id: true,
          medicationId: true,
          takenAt: true,
          skipped: true,
          deletedAt: true,
          inventoryConsumption: true,
        },
      });
      if (
        !event ||
        event.deletedAt !== null ||
        event.takenAt === null ||
        event.skipped ||
        event.inventoryConsumption !== null
      ) {
        return;
      }

      const medication = await tx.medication.findFirst({
        where: { id: medicationId, userId },
        select: { unitsPerDose: true },
      });
      if (!medication) return;
      const unitsPerDose = Math.max(1, medication.unitsPerDose);

      // Candidate containers, in consumption order: the open container
      // first (earliest in-use deadline), then FEFO over unopened
      // stock. Both lists are loaded inside the transaction so the
      // updates apply to the rows just read.
      const inUse = await tx.medicationInventoryItem.findMany({
        where: {
          userId,
          medicationId,
          state: "IN_USE",
          unitsRemaining: { gt: 0 },
        },
        orderBy: [
          { expiresAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });
      const active = await tx.medicationInventoryItem.findMany({
        where: {
          userId,
          medicationId,
          state: "ACTIVE",
          unitsRemaining: { gt: 0 },
        },
        orderBy: [
          { printedExpiry: { sort: "asc", nulls: "last" } },
          { purchasedAt: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
        ],
      });

      const stamp: InventoryConsumptionEntry[] = [];
      const itemIds: string[] = [];
      let autoOpened = 0;
      let owed = unitsPerDose;
      // State derives at the WALL clock, not the intake instant: a
      // backdated take that auto-opens a container starts its in-use
      // window at the (past) intakeAt, so the container can land
      // straight in EXPIRED when that window has already lapsed by now
      // — correct, the daily cron would flip it on the next sweep
      // anyway.
      const nowMs = Date.now();

      for (const item of [...inUse, ...active]) {
        if (owed <= 0) break;
        const take = Math.min(owed, item.unitsRemaining);
        if (take <= 0) continue;

        const wasUnopened = item.firstUseAt === null;
        const nextFirstUseAt = item.firstUseAt ?? intakeAt;
        const nextUnitsRemaining = item.unitsRemaining - take;
        const nextExpiresAt = computeExpiresAt(
          nextFirstUseAt,
          item.printedExpiry,
        );
        const nextState = computeInventoryState(
          {
            state: item.state,
            unitsTotal: item.unitsTotal,
            unitsRemaining: nextUnitsRemaining,
            firstUseAt: nextFirstUseAt,
            printedExpiry: item.printedExpiry,
          },
          nowMs,
        );

        await tx.medicationInventoryItem.update({
          where: { id: item.id },
          data: {
            state: nextState,
            unitsRemaining: nextUnitsRemaining,
            firstUseAt: nextFirstUseAt,
            expiresAt: nextExpiresAt,
          },
        });

        stamp.push({ itemId: item.id, units: take });
        itemIds.push(item.id);
        if (wasUnopened) autoOpened += 1;
        owed -= take;
      }

      // Stamp the event even when nothing (or only part) could be
      // consumed: the stamp is the exactly-once gate, and a dose taken
      // with no tracked stock must not retro-consume containers
      // registered later when a sync replay revisits the row.
      await tx.medicationIntakeEvent.update({
        where: { id: event.id },
        data: { inventoryConsumption: stamp as unknown as Prisma.InputJsonValue },
      });

      annotate({
        action: { name: "medication.inventory.consumed" },
        meta: {
          medication_id: medicationId,
          units: unitsPerDose - owed,
          item_ids: itemIds,
          auto_opened: autoOpened,
        },
      });
    });
  } catch (err) {
    annotate({
      action: { name: "medication.inventory.consume_error" },
      meta: {
        medication_id: medicationId,
        event_id: eventId,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

/**
 * Refund the consumption a stamped intake event recorded and clear
 * the stamp.
 *
 * No stamp = no-op (the row never consumed, or was already restored).
 * Each refund is clamped to the item's `unitsTotal` so a stock
 * correction in between can never overfill a container; the state
 * re-derives through the state machine, so a USED_UP container whose
 * units come back flips to IN_USE (or EXPIRED when its clock has
 * lapsed meanwhile). A stamped item that was deleted since is skipped.
 */
export async function restoreForIntake(input: {
  client: ConsumptionClient;
  userId: string;
  eventId: string;
}): Promise<void> {
  const { client, userId, eventId } = input;
  try {
    await runAtomically(client, async (tx) => {
      const event = await tx.medicationIntakeEvent.findFirst({
        where: { id: eventId, userId },
        select: {
          id: true,
          medicationId: true,
          inventoryConsumption: true,
        },
      });
      if (!event) return;
      const stamp = parseStamp(event.inventoryConsumption);
      if (stamp === null || stamp.length === 0) {
        // Clear an empty/malformed stamp so a later re-take can
        // consume afresh; a NULL stamp is already clear.
        if (event.inventoryConsumption !== null) {
          await tx.medicationIntakeEvent.update({
            where: { id: event.id },
            data: { inventoryConsumption: Prisma.DbNull },
          });
        }
        return;
      }

      const nowMs = Date.now();
      let refunded = 0;
      const itemIds: string[] = [];
      for (const entry of stamp) {
        const item = await tx.medicationInventoryItem.findFirst({
          where: { id: entry.itemId, userId },
        });
        if (!item) continue; // container deleted since — nothing to refund.

        const nextUnitsRemaining = Math.min(
          item.unitsTotal,
          item.unitsRemaining + entry.units,
        );
        const refundedHere = nextUnitsRemaining - item.unitsRemaining;
        const nextState = computeInventoryState(
          {
            state: item.state,
            unitsTotal: item.unitsTotal,
            unitsRemaining: nextUnitsRemaining,
            firstUseAt: item.firstUseAt,
            printedExpiry: item.printedExpiry,
          },
          nowMs,
        );
        await tx.medicationInventoryItem.update({
          where: { id: item.id },
          data: {
            state: nextState,
            unitsRemaining: nextUnitsRemaining,
          },
        });
        refunded += refundedHere;
        itemIds.push(item.id);
      }

      await tx.medicationIntakeEvent.update({
        where: { id: event.id },
        data: { inventoryConsumption: Prisma.DbNull },
      });

      annotate({
        action: { name: "medication.inventory.restored" },
        meta: {
          medication_id: event.medicationId,
          units: refunded,
          item_ids: itemIds,
        },
      });
    });
  } catch (err) {
    annotate({
      action: { name: "medication.inventory.restore_error" },
      meta: {
        event_id: eventId,
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
