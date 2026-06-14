/**
 * v1.17 W1b — single Health-Score BP-pillar input builder.
 *
 * The Personal Health Score is computed by `computeUserHealthScoreFastPath`
 * from two server callers: the analytics route (the Insights health-score
 * card) and the dashboard snapshot (the hero ring). Before this builder the
 * two callers assembled the BP-pillar inputs by hand and DIVERGED:
 *
 *   - the analytics route fed the BP pillar from the all-time in-target rate
 *     and passed the prior-week values for the week-over-week delta;
 *   - the dashboard snapshot fed the pillar from the trailing-30-day rate and
 *     omitted the prior-week values entirely (so the ring's delta zeroed BP
 *     out and the pillar's presence gate flipped on a user with BP history
 *     but no readings in the last month).
 *
 * Same user, two different scores and two different bands. v1.17 W1d already
 * unified the WINDOW (both read the trailing-90-day rate); this builder
 * unifies the ASSEMBLY so the window choice, the all-time fallback, the
 * graded-score wiring and the prior-week delta inputs can never drift between
 * the two surfaces again. Both callers pass the identical
 * `BpInTargetEnvelope` pair through here and consume the result verbatim.
 *
 * Pure & deterministic — no I/O. The callers own the
 * `computeBpInTargetFastPath` reads (current + prior-week) and hand the two
 * envelopes in.
 */
import type { BpInTargetEnvelope } from "./bp-in-target-fast-path";

/**
 * The BP-pillar slice of `HealthScoreFastPathInput`. Both Health-Score
 * callers spread this into their `computeUserHealthScoreFastPath` call so the
 * pillar is graded off identical inputs regardless of surface.
 */
export interface HealthScoreBpInputs {
  bpInTargetPct: number | null;
  bpInTargetPctPriorWeek: number | null;
  bpGradedScore: number | null;
  bpGradedScorePriorWeek: number | null;
}

/**
 * Build the BP-pillar inputs from the current-window and prior-week
 * `computeBpInTargetFastPath` envelopes.
 *
 * - The pillar rate (presence gate + secondary stat) reads the canonical
 *   trailing-90-day window (W1d), falling back to the all-time rate only when
 *   the 90-day window is itself null so a sparse-but-historical account keeps
 *   its BP pillar.
 * - The prior-week rate uses the prior-week run's 90-day window so the
 *   week-over-week delta compares the same window on both ends.
 * - The graded clinical-proximity score (the pillar VALUE) and its prior-week
 *   counterpart come straight off the envelopes.
 *
 * `null` for the current envelope (no BP targets / no readings) collapses
 * every field to `null`, which the score helper reads as "pillar absent".
 */
export function buildHealthScoreBpInputs(
  current: BpInTargetEnvelope | null,
  priorWeek: BpInTargetEnvelope | null,
): HealthScoreBpInputs {
  if (!current) {
    return {
      bpInTargetPct: null,
      bpInTargetPctPriorWeek: null,
      bpGradedScore: null,
      bpGradedScorePriorWeek: null,
    };
  }
  const bpInTargetPct = current.last90Days?.pct ?? current.allTime?.pct ?? null;
  const bpInTargetPctPriorWeek =
    priorWeek?.last90Days?.pct ?? priorWeek?.allTime?.pct ?? null;
  return {
    bpInTargetPct,
    bpInTargetPctPriorWeek,
    bpGradedScore: current.gradedScore,
    bpGradedScorePriorWeek: priorWeek?.gradedScore ?? null,
  };
}
