/**
 * Hydration logging — pure helpers for the daily water-intake goal ring.
 *
 * Water intake is stored as `WATER_INTAKE` Measurement rows in millilitres
 * (ml), one row per quick-add entry. The day's running total is the SUM of
 * those rows (see `CUMULATIVE_HK_TYPES`); the goal ring compares that total
 * against a per-user goal (`User.hydrationGoalMl`, null = the default).
 *
 * The math lives here, free of Prisma + React, so the ring states (empty /
 * partial / met / exceeded) are unit-testable in isolation.
 */

/** Default daily hydration goal when the user has not set their own (ml). */
export const DEFAULT_HYDRATION_GOAL_ML = 2000;

/** Bounds for a user-set goal — a plausible adult range, not a clinical limit. */
export const MIN_HYDRATION_GOAL_ML = 250;
export const MAX_HYDRATION_GOAL_ML = 8000;

/** The fixed quick-add amounts the card offers alongside a custom entry (ml). */
export const HYDRATION_QUICK_ADD_ML = [250, 500] as const;

/** Bounds for a single logged entry (ml) — mirrors the measurement clamp. */
export const MIN_HYDRATION_ENTRY_ML = 1;
export const MAX_HYDRATION_ENTRY_ML = 5000;

/**
 * Resolve the effective goal from the (nullable) stored value: fall back to
 * the default when unset, and clamp a stored value into the supported band so
 * a stale out-of-range row never produces a broken ring.
 */
export function resolveHydrationGoal(
  stored: number | null | undefined,
): number {
  if (stored == null || !Number.isFinite(stored)) {
    return DEFAULT_HYDRATION_GOAL_ML;
  }
  return Math.min(
    MAX_HYDRATION_GOAL_ML,
    Math.max(MIN_HYDRATION_GOAL_ML, Math.round(stored)),
  );
}

export interface HydrationSummary {
  /** Today's summed intake in ml. */
  totalMl: number;
  /** The effective daily goal in ml. */
  goalMl: number;
  /** Progress toward the goal, capped at 100 for the ring fill. */
  percent: number;
  /** Uncapped progress (can exceed 100 once the goal is met). */
  rawPercent: number;
  /** Whether the day's total has reached the goal. */
  met: boolean;
  /** Remaining ml to the goal (0 once met). */
  remainingMl: number;
}

/**
 * Summarise a day's intake against a goal. `totalMl` is the already-summed
 * day total; `goalMl` is the effective goal (run it through
 * `resolveHydrationGoal` first). Negative totals are floored at 0.
 */
export function summariseHydration(
  totalMl: number,
  goalMl: number,
): HydrationSummary {
  const total = Number.isFinite(totalMl) ? Math.max(0, Math.round(totalMl)) : 0;
  const goal = resolveHydrationGoal(goalMl);
  const rawPercent = goal > 0 ? Math.round((total / goal) * 100) : 0;
  const percent = Math.min(100, rawPercent);
  return {
    totalMl: total,
    goalMl: goal,
    percent,
    rawPercent,
    met: total >= goal,
    remainingMl: Math.max(0, goal - total),
  };
}
