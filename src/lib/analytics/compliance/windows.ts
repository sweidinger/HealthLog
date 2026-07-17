// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import type {
  ComplianceIntakeInstant,
  ComplianceMedicationContext,
  ComplianceSchedule,
} from "./types";
import { expectedSlotsBetween } from "./occurrences";

/**
 * v1.8.6 — the floor at which a window's percentage is stable. Four
 * expected doses is the point where a single miss moves the rate by ≤25%
 * rather than ±50–100%. A daily med clears it in a 7-day window; a weekly
 * med needs ~30 days; a tri-weekly / 35-day-rolling med needs a quarter or
 * more. The window ladder below steps up until both rows clear this floor.
 */
export const MIN_STABLE_DOSES = 4;

/**
 * v1.8.6 — the rung ladder for the two compliance windows. Each rung is a
 * `[short, long]` pair of day-counts. The card always shows two percentage
 * rows; the only thing that scales with cadence is which rung the windows
 * sit on. Dense meds (daily / weekday) sit on `[7, 30]`; as the expected
 * dose frequency drops, both windows step up so each row still spans enough
 * expected doses to mean something, up to a 12-month long window for very
 * rare meds.
 */
export const COMPLIANCE_WINDOW_LADDER: ReadonlyArray<
  readonly [number, number]
> = [
  [7, 30],
  [30, 90],
  [90, 365],
];

/**
 * v1.8.6 — the day-counts of the two compliance windows a medication's
 * cadence resolves to, plus the realised expected-dose count each window
 * holds. `shortDays` / `longDays` drive the row labels; the expected counts
 * are surfaced so a client can show the denominator or re-derive the rung.
 */
export interface ComplianceWindowSelection {
  shortDays: number;
  longDays: number;
  expectedShort: number;
  expectedLong: number;
}

/**
 * v1.8.6 — pick the two compliance windows for a medication from its
 * dosing cadence.
 *
 * Walks {@link COMPLIANCE_WINDOW_LADDER} from densest to sparsest and
 * returns the first rung whose BOTH windows clear {@link MIN_STABLE_DOSES}
 * realised expected doses. A daily med clears `[7, 30]` immediately; a
 * weekly med fails the 7-day row (one dose) and lands on `[30, 90]`; a
 * 35-day-rolling injection needs the top rung `[90, 365]`. When even the
 * top rung can't clear the floor (a brand-new prescription, a very rare
 * med) the top rung is returned anyway so the card still shows two honest
 * percentage rows over the widest windows available.
 *
 * The expected count routes through {@link expectedSlotsBetween} (the
 * canonical recurrence engine), so PRN / off-cadence / pre-creation days
 * never inflate the denominator.
 */
export function selectComplianceWindows(
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  options?: { now?: Date; intakes?: ComplianceIntakeInstant[] },
): ComplianceWindowSelection {
  const now = options?.now ?? new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const expectedOver = (days: number): number =>
    expectedSlotsBetween(
      schedules,
      new Date(now.getTime() - days * DAY_MS),
      now,
      ctx,
      options?.intakes,
    ).length;

  // Memoise per distinct window so a shared rung boundary (e.g. 30 / 90)
  // isn't re-walked across rungs.
  const cache = new Map<number, number>();
  const expected = (days: number): number => {
    const hit = cache.get(days);
    if (hit !== undefined) return hit;
    const v = expectedOver(days);
    cache.set(days, v);
    return v;
  };

  for (const [shortDays, longDays] of COMPLIANCE_WINDOW_LADDER) {
    const expectedShort = expected(shortDays);
    const expectedLong = expected(longDays);
    if (expectedShort >= MIN_STABLE_DOSES && expectedLong >= MIN_STABLE_DOSES) {
      return { shortDays, longDays, expectedShort, expectedLong };
    }
  }

  // No rung cleared the floor — fall back to the widest rung so both rows
  // still render over the most data the cadence affords.
  const [shortDays, longDays] =
    COMPLIANCE_WINDOW_LADDER[COMPLIANCE_WINDOW_LADDER.length - 1];
  return {
    shortDays,
    longDays,
    expectedShort: expected(shortDays),
    expectedLong: expected(longDays),
  };
}
