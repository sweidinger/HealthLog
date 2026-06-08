/**
 * v1.15.18 — window-band intake→slot attribution.
 *
 * The medical core of the traceable dose-history model. It replaces the two
 * wide nearest-neighbour matchers that mis-attributed irregular real intakes:
 *
 *   - WRITE-time: the ±6h `snapToleranceMs` snap in `resolve-slot-instant.ts`
 *     (½ the inter-slot gap), which pulled a 13:02 take onto the 19:00 slot
 *     and an 15:46 take onto the 07:00 slot.
 *   - READ-time:  the ±12h/half-gap `slotMatchRadius` in `cadence.ts`.
 *
 * Attribution is now pure band membership against each slot's configurable
 * dose window (the on-time band) plus a late tail:
 *
 *   - intake ∈ [onTimeStart, onTimeEnd]  → on_time (this slot)
 *   - intake ∈ (onTimeEnd, overdueEnd]   → late    (this slot)
 *   - otherwise                          → null    (ad-hoc: standalone row,
 *                                          the slot stays missed if unfilled)
 *
 * `overdueEnd` (the late tail past `onTimeEnd`) is capped at the next slot's
 * `onTimeStart`, so two adjacent same-day slots can never both claim one
 * intake. The on-time band IS the user's per-dose window: a point time maps to
 * a symmetric ±half-width, an explicit window to `[start, end]`. All bounds are
 * instants — the caller mints them DST-correctly via `localHmAsUtc`, keeping
 * this module timezone-agnostic and trivially testable.
 */

/** Per-slot window the caller supplies (bounds already minted as instants). */
export interface SlotWindowInput {
  /** Canonical anchor instant for the slot (labelling / next-due / pairing). */
  at: Date;
  /** "HH:mm" the slot represents (for the history label + dedup key). */
  timeOfDay: string;
  /** On-time band lower bound (inclusive). */
  onTimeStart: Date;
  /** On-time band upper bound (inclusive). */
  onTimeEnd: Date;
  /** Late tail past `onTimeEnd` that still counts as taken-late, in ms. */
  lateGraceMs: number;
}

/** A slot window with its (capped) late-tail cutoff resolved. */
export interface SlotBand extends SlotWindowInput {
  /** Cutoff past which a take no longer pairs to this slot (capped). */
  overdueEnd: Date;
}

export type AttributionStatus = "on_time" | "late";

export interface AttributionResult {
  band: SlotBand;
  status: AttributionStatus;
}

/**
 * Resolve each slot's `overdueEnd` = `onTimeEnd + lateGraceMs`, capped at the
 * next slot's `onTimeStart` so adjacent slots' capture bands stay disjoint.
 * The input is sorted by anchor instant; the returned bands preserve that order.
 */
export function buildSlotBands(slots: SlotWindowInput[]): SlotBand[] {
  const sorted = [...slots].sort((a, b) => a.at.getTime() - b.at.getTime());
  return sorted.map((slot, i) => {
    let overdueEnd = slot.onTimeEnd.getTime() + slot.lateGraceMs;
    const next = sorted[i + 1];
    if (next) {
      // Never let one slot's late tail bleed into the next slot's on-time
      // window — the cap keeps the two capture bands disjoint.
      overdueEnd = Math.min(overdueEnd, next.onTimeStart.getTime());
    }
    // A degenerate/negative tail collapses to the on-time end.
    overdueEnd = Math.max(overdueEnd, slot.onTimeEnd.getTime());
    return { ...slot, overdueEnd: new Date(overdueEnd) };
  });
}

/**
 * Attribute an intake instant to the slot whose window contains it, or `null`
 * when it falls in no slot's band (an ad-hoc / off-schedule intake).
 *
 * On overlap-free bands at most one slot matches. As a defensive tie-break
 * (custom windows a caller hand-builds could overlap), an on-time match wins
 * over a late match, then the nearer anchor wins.
 */
export function attributeIntakeToSlot(
  intakeAt: Date,
  bands: SlotBand[],
): AttributionResult | null {
  const t = intakeAt.getTime();
  let best: { result: AttributionResult; rank: number; dist: number } | null =
    null;

  for (const band of bands) {
    const onStart = band.onTimeStart.getTime();
    const onEnd = band.onTimeEnd.getTime();
    const overdueEnd = band.overdueEnd.getTime();

    let status: AttributionStatus | null = null;
    if (t >= onStart && t <= onEnd) status = "on_time";
    else if (t > onEnd && t <= overdueEnd) status = "late";
    if (status === null) continue;

    // on_time (rank 0) beats late (rank 1); within a rank the nearer anchor
    // wins. Keeps a deterministic pick if a caller's custom bands overlap.
    const rank = status === "on_time" ? 0 : 1;
    const dist = Math.abs(t - band.at.getTime());
    if (
      best === null ||
      rank < best.rank ||
      (rank === best.rank && dist < best.dist)
    ) {
      best = { result: { band, status }, rank, dist };
    }
  }

  return best?.result ?? null;
}
