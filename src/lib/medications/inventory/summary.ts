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
 */

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
  const unitsRemaining = available.reduce(
    (sum, item) => sum + item.unitsRemaining,
    0,
  );
  const unitsTotal = available.reduce((sum, item) => sum + item.unitsTotal, 0);
  const expiredUnits = items
    .filter((item) => item.state === "EXPIRED")
    .reduce((sum, item) => sum + item.unitsRemaining, 0);
  return {
    unitsRemaining,
    unitsTotal,
    dosesRemaining: Math.floor(unitsRemaining / perDose),
    dosesTotal: Math.floor(unitsTotal / perDose),
    expiredUnits,
  };
}
