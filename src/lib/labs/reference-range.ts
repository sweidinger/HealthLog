/**
 * v1.18.0 — single source of truth for lab reference-range classification
 * and range-string structure.
 *
 * Three surfaces need the same logic: the API response (`rangeStatus`), the
 * doctor-report PDF table, and the lab list card. They were drifting copies.
 * The CLASSIFICATION (below / in-range / above / unknown) and the range
 * STRUCTURE (`low–high` / `≤ high` / `≥ low` / empty) are shared here; the
 * per-surface NUMBER FORMATTING stays a caller concern — the PDF wants a
 * locale-aware one-decimal formatter, the list trims to int/2-dec — so
 * `formatReferenceRange` takes a `formatNumber` callback and never imposes a
 * formatter of its own.
 */

/**
 * Reference-range classification. Deliberately a three-state, NEUTRAL
 * verdict — the badge that renders it must stay calm and informative, NOT
 * alarming (no red "out of range" tint). `"unknown"` when the lab reported
 * no usable bounds.
 *
 * Bounds are treated as inclusive: a value exactly on the reference limit
 * reads as in-range, matching how labs print "≤" / "≥" reference notation.
 */
export type ReferenceRangeStatus = "in-range" | "below" | "above" | "unknown";

export function classifyReferenceRange(
  value: number,
  referenceLow: number | null | undefined,
  referenceHigh: number | null | undefined,
): ReferenceRangeStatus {
  const hasLow = referenceLow !== null && referenceLow !== undefined;
  const hasHigh = referenceHigh !== null && referenceHigh !== undefined;
  if (!hasLow && !hasHigh) return "unknown";
  if (hasLow && value < (referenceLow as number)) return "below";
  if (hasHigh && value > (referenceHigh as number)) return "above";
  return "in-range";
}

/**
 * Render the reference range as text. Owns only the STRUCTURE — which of the
 * four shapes (`low–high`, `≤ high`, `≥ low`, empty) applies — and defers
 * every digit to the caller-supplied `formatNumber`, so each surface keeps
 * its own number formatting byte-for-byte.
 *
 * `emptyText` is what to return when the lab reported no bounds at all; it
 * defaults to the empty string (the lab list never renders the no-bounds
 * case), while the PDF passes a neutral em-dash placeholder.
 */
export function formatReferenceRange(
  low: number | null | undefined,
  high: number | null | undefined,
  formatNumber: (value: number) => string,
  opts?: { emptyText?: string },
): string {
  const hasLow = low !== null && low !== undefined;
  const hasHigh = high !== null && high !== undefined;
  if (hasLow && hasHigh) {
    return `${formatNumber(low as number)}–${formatNumber(high as number)}`;
  }
  if (hasHigh) return `≤ ${formatNumber(high as number)}`;
  if (hasLow) return `≥ ${formatNumber(low as number)}`;
  return opts?.emptyText ?? "";
}
