/**
 * v1.16.10 — shared supply-summary math for every stock readout.
 *
 * One predicate decides what counts as AVAILABLE supply: ACTIVE or
 * IN_USE containers with units left — the same filter the medications
 * list route (`stockUnitsRemaining`), the GLP-1 detail endpoint and the
 * Coach snapshot run. EXPIRED stock is visible but never available:
 * it surfaces separately (`expiredUnits`) so the UI can show a muted
 * "expired" suffix without folding it into the headline or the runway
 * estimate. USED_UP containers count nowhere.
 *
 * The Übersicht supply row and the Bestand summary both render from
 * this helper, so the surfaces cannot disagree about what "remaining"
 * means.
 *
 * v1.18.11 (#31) — this is also the single canonical sanity gate for
 * the surfaced stock. A self-hoster reported the headline Bestand going
 * nonsensically NEGATIVE. The container write paths floor at zero
 * structurally (consumption never over-decrements, the stock-correction
 * route clamps at `.min(0)` and re-runs the state machine), and the
 * legacy running-sum ledger reads are clamped with `Math.max(0, …)` at
 * their two call sites — but nothing guaranteed the POOLED figure this
 * helper returns could not go negative from a single corrupt / legacy
 * row carrying a negative `unitsRemaining` (or `unitsTotal`). Rather
 * than leave each surface to re-clamp, the floor lives HERE, at the one
 * point every readout flows through, and a raw-negative pool emits a
 * `medication.inventory.underflow` wide-event so the underlying bug is
 * observable if it ever recurs.
 */

import { annotate } from "@/lib/logging/context";

export type SupplyItemState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";

export interface SupplyItem {
  state: SupplyItemState;
  unitsTotal: number;
  unitsRemaining: number;
}

export interface SupplySummary {
  /** Pooled units across available (ACTIVE / IN_USE, units left) containers. */
  unitsRemaining: number;
  /** Pooled capacity across the same available containers. */
  unitsTotal: number;
  /** Dose-derived headline: floor(unitsRemaining / unitsPerDose). */
  dosesRemaining: number;
  /** Dose-derived capacity: floor(unitsTotal / unitsPerDose). */
  dosesTotal: number;
  /** Units still sitting in EXPIRED containers — visible, never available. */
  expiredUnits: number;
}

/** The list-route / GLP-1 availability predicate, verbatim. */
export function isAvailableSupply(item: SupplyItem): boolean {
  return (
    (item.state === "ACTIVE" || item.state === "IN_USE") &&
    item.unitsRemaining > 0
  );
}

export function summariseSupply(
  items: readonly SupplyItem[],
  unitsPerDose: number,
): SupplySummary {
  // v1.16.12 — guard at > 0, NOT ≥ 1: a fractional unitsPerDose (½ tablet
  // per dose) must stay fractional, else the dose-derived counts halve.
  const perDose = unitsPerDose > 0 ? unitsPerDose : 1;
  const available = items.filter(isAvailableSupply);
  const rawUnitsRemaining = available.reduce(
    (sum, item) => sum + item.unitsRemaining,
    0,
  );
  const rawUnitsTotal = available.reduce(
    (sum, item) => sum + item.unitsTotal,
    0,
  );
  const expiredUnits = clampNonNegative(
    items
      .filter((item) => item.state === "EXPIRED")
      .reduce((sum, item) => sum + item.unitsRemaining, 0),
  );

  // v1.18.11 (#31) — central sanity gate. A NaN / negative pool can only
  // come from a corrupt or legacy row that slipped past the per-row
  // availability predicate; never surface it. Clamp to zero (the dose
  // ran out) and emit an underflow wide-event so the data defect stays
  // observable — `annotate` is a no-op outside a request context, so the
  // pure helper stays safe to call from a server component.
  const unitsRemaining = clampNonNegative(rawUnitsRemaining);
  const unitsTotal = clampNonNegative(rawUnitsTotal);
  if (
    !Number.isFinite(rawUnitsRemaining) ||
    rawUnitsRemaining < 0 ||
    !Number.isFinite(rawUnitsTotal) ||
    rawUnitsTotal < 0
  ) {
    annotate({
      action: { name: "medication.inventory.underflow" },
      meta: {
        raw_units_remaining: Number.isFinite(rawUnitsRemaining)
          ? rawUnitsRemaining
          : null,
        raw_units_total: Number.isFinite(rawUnitsTotal) ? rawUnitsTotal : null,
        clamped_units_remaining: unitsRemaining,
        available_count: available.length,
      },
    });
  }

  return {
    unitsRemaining,
    unitsTotal,
    dosesRemaining: Math.floor(unitsRemaining / perDose),
    dosesTotal: Math.floor(unitsTotal / perDose),
    expiredUnits,
  };
}

/** Floor a pooled figure at zero, treating a non-finite value as zero
 *  too — a corrupt row must never surface as `NaN` or a negative. */
function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
