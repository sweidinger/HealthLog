/**
 * Coach-nudge trend thresholds shared with client-reachable code.
 *
 * Kept in a leaf module — free of any server-only import — because the
 * dashboard hero's verdict resolver (`@/lib/dashboard/verdict`) reads
 * these to stay numerically identical to the nudge cron, and that
 * resolver runs inside a `"use client"` component. Importing them from
 * `@/lib/jobs/coach-nudge` would drag the prisma/dispatcher server
 * graph into the browser bundle (the same regression class the
 * dose-window defaults hit — see
 * `src/lib/medications/scheduling/dose-window-defaults.ts`).
 * `@/lib/jobs/coach-nudge` re-exports both so server-side imports keep
 * their path.
 */

/** Weight trigger: minimum kg the weekly mean must drift AWAY from the range. */
export const COACH_NUDGE_WEIGHT_DRIFT_KG = 0.5;
/** Sleep trigger: a night must undershoot the floor by this margin (h). */
export const COACH_NUDGE_SLEEP_DEFICIT_MARGIN_H = 0.5;
