/**
 * v1.4.25 W19b — pen / vial inventory state machine.
 *
 * Pure functions over a minimal `InventoryItemView` shape — no DB
 * access, no Prisma imports. The route handlers, the consumption hook
 * (`./consumption.ts`), and the daily expire cron all compose this
 * module with their own persistence layer.
 *
 * Decision tree (in evaluation order):
 *   1. unitsRemaining === 0           → USED_UP   (terminal)
 *   2. printedExpiry  && now > expiry → EXPIRED   (printed label trumps clock)
 *   3. firstUseAt && now > firstUseAt + IN_USE_WINDOW_MS → EXPIRED
 *   4. firstUseAt is set              → IN_USE
 *   5. otherwise                      → ACTIVE
 *
 * v1.16.10 — the item counts UNITS (tablets / ampoules / puffs), not
 * doses; `Medication.unitsPerDose` maps between the two. The state
 * machine is unit-agnostic — it only cares whether the count reached
 * zero.
 *
 * The window length is fixed at 30 days per EMA EPAR §6.3 for
 * Mounjaro KwikPen / Saxenda / Trulicity. Ozempic ships with a 56-day
 * window per its own EPAR — that drug-specific override is *not*
 * encoded here yet. The W19b scope deliberately uses the
 * conservative 30-day default; a follow-up can read the
 * drug-knowledge layer (`glp1-knowledge.ts`) and parametrise the
 * window per Glp1DrugId. The state machine itself remains
 * window-agnostic — it accepts the window length as input.
 */

import type { MedicationInventoryState } from "@/generated/prisma/client";

/** Default in-use window per EMA EPAR §6.3 for the strictest GLP-1
 *  agonists (Mounjaro, Saxenda, Trulicity). 30 days. */
export const DEFAULT_IN_USE_WINDOW_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The subset of `MedicationInventoryItem` the state machine needs.
 * Decoupling here means tests don't have to construct a full Prisma
 * row, and the helper composes cleanly with the route layer's
 * partial-update shapes.
 */
export interface InventoryItemView {
  state: MedicationInventoryState;
  unitsTotal: number;
  unitsRemaining: number;
  firstUseAt: Date | null;
  printedExpiry: Date | null;
}

/**
 * Resolve the canonical state for a pen / vial given the wall clock.
 *
 * The function is pure — given the same input it always returns the
 * same state — so the caller can re-evaluate as often as it wants
 * without side-effects. The expire-cron and the consumption hook both
 * use this same evaluator; the only difference is what they do with
 * the result.
 */
export function computeInventoryState(
  item: InventoryItemView,
  nowMs: number,
  inUseWindowDays: number = DEFAULT_IN_USE_WINDOW_DAYS,
): MedicationInventoryState {
  // (1) Terminal — once a container is used up, it stays used up. The
  // printed expiry on an empty container is irrelevant; the EXPIRED
  // state exists to warn the user not to dose from a container that's
  // still got units but has gone stale, and an empty one has neither
  // problem.
  if (item.unitsRemaining <= 0) {
    return "USED_UP";
  }

  // (2) Printed expiry trumps the in-use clock. A container whose
  // carton expiry has lapsed is EXPIRED even if it was never opened.
  if (item.printedExpiry && nowMs > item.printedExpiry.getTime()) {
    return "EXPIRED";
  }

  // (3) In-use clock blew. firstUseAt + window < now ⇒ EXPIRED.
  if (item.firstUseAt) {
    const inUseDeadlineMs =
      item.firstUseAt.getTime() + inUseWindowDays * MS_PER_DAY;
    if (nowMs > inUseDeadlineMs) {
      return "EXPIRED";
    }
    // (4) Has been opened but still inside the window.
    return "IN_USE";
  }

  // (5) Refrigerated, unopened.
  return "ACTIVE";
}

/**
 * Compute the `expiresAt` column. It's the min of the in-use
 * deadline (firstUseAt + window) and the printed expiry — whichever
 * lands first. If the container has never been opened we fall back to
 * the printed expiry alone (in-use clock hasn't started). If neither
 * is set we return null so the daily expire-cron has nothing to scan.
 */
export function computeExpiresAt(
  firstUseAt: Date | null,
  printedExpiry: Date | null,
  inUseWindowDays: number = DEFAULT_IN_USE_WINDOW_DAYS,
): Date | null {
  const inUseDeadline = firstUseAt
    ? new Date(firstUseAt.getTime() + inUseWindowDays * MS_PER_DAY)
    : null;

  if (inUseDeadline && printedExpiry) {
    return inUseDeadline.getTime() < printedExpiry.getTime()
      ? inUseDeadline
      : printedExpiry;
  }
  return inUseDeadline ?? printedExpiry ?? null;
}

/**
 * Whole-days remaining in the 30-day in-use window, rounded toward
 * zero. Returns null when the container is not currently IN_USE (the
 * UI surface for ACTIVE / EXPIRED / USED_UP shows a different label).
 *
 * The day count is computed against the in-use deadline only —
 * the printed expiry is its own separate countdown surfaced as the
 * "Carton expires {date}" label. This split avoids the UI lying to
 * the user when the printed expiry is more imminent than the
 * in-use deadline (the EXPIRED transition is still correct via
 * `computeInventoryState`, but the day-count chip shows the
 * 30-day-clock number).
 *
 * v1.4.25 W21 Fix-N — widened to accept either the full
 * `InventoryItemView` (server-side path: state-machine-gated, returns
 * null for non-IN_USE) OR a thin `{ firstUseAt }` shape (caller
 * already knows state is IN_USE so the gate is a no-op). The widening
 * collapsed an earlier reimplementation in the now-retired web
 * inventory surface; the helper stays because the GLP-1 details
 * endpoint still computes weeksOfSupply for iOS.
 */
export function daysRemainingInUse(
  item: InventoryItemView | { firstUseAt: Date | string | null },
  nowMs: number,
  inUseWindowDays: number = DEFAULT_IN_USE_WINDOW_DAYS,
): number | null {
  const firstUseRaw = item.firstUseAt;
  if (!firstUseRaw) return null;
  const firstUseAt =
    firstUseRaw instanceof Date ? firstUseRaw : new Date(firstUseRaw);
  // Only the full view triggers the state-machine gate; thin callers
  // (the inventory disclosure UI on the medication card) supply just
  // `firstUseAt` and have already filtered on state === "IN_USE" before
  // reaching here. The gate is silently skipped for the thin form.
  if ("state" in item && "unitsRemaining" in item) {
    const state = computeInventoryState(
      { ...item, firstUseAt },
      nowMs,
      inUseWindowDays,
    );
    if (state !== "IN_USE") return null;
  }
  const deadlineMs = firstUseAt.getTime() + inUseWindowDays * MS_PER_DAY;
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) return 0;
  return Math.floor(remainingMs / MS_PER_DAY);
}
