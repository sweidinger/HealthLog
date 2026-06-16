/**
 * Illness retrospective summary (v1.18.1, Workstream B / P3).
 *
 * The look-back surface: "sick N times this year · typical recovery gap X
 * days". RETROSPECTIVE ONLY — it summarises what already happened. It is
 * NEVER a predictor or diagnoser; the recurrence figure is a count of past
 * episodes, not a forecast, and the copy layer must frame it as such.
 *
 * Pure given a list of resolved episode summaries + their computed gaps. The
 * caller resolves the per-episode recovery-gap (via the correlation engine,
 * which is itself coverage-gated) and passes the numbers in; this layer only
 * aggregates. The aggregate is itself gated — with too few resolved episodes
 * to say anything honest, it reports the count but withholds the "typical
 * gap" (asserts nothing thin).
 */
import { median } from "@/lib/insights/derived/baseline";

/** Minimum resolved-with-gap episodes before a "typical gap" is asserted. */
export const MIN_EPISODES_FOR_TYPICAL_GAP = 3;

/** One episode's contribution to the summary. */
export interface RetrospectiveEpisode {
  id: string;
  type: string;
  /** Onset local day `YYYY-MM-DD` (for the recurrence-month tally). */
  onsetDay: string;
  /** Whether the episode is resolved (has a felt-better marker). */
  resolved: boolean;
  /** The computed recovery-gap in days, or null when ungated/unavailable. */
  recoveryGapDays: number | null;
  /** Lifecycle — CHRONIC_ONGOING never contributes a gap. */
  lifecycle: string;
}

export interface IllnessRetrospectiveSummary {
  /** Episodes whose onset falls in the requested window (e.g. trailing year). */
  episodeCount: number;
  /** Of those, how many are resolved. */
  resolvedCount: number;
  /**
   * Typical (median) recovery-gap in days across episodes with a computed
   * gap — null when fewer than `MIN_EPISODES_FOR_TYPICAL_GAP` qualify. A
   * positive gap means the body typically lagged the felt-better marker.
   */
  typicalRecoveryGapDays: number | null;
  /** How many episodes backed the typical-gap figure (transparency). */
  gapSampleSize: number;
  /**
   * Recurrence tally by calendar month (1–12) → count, retrospective only.
   * Drives "you tend to log illnesses in November" as an OBSERVATION, never
   * a prediction. Empty when nothing falls in the window.
   */
  byMonth: Record<number, number>;
  /** Per-type episode counts in the window (retrospective breakdown). */
  byType: Record<string, number>;
}

/**
 * Aggregate the per-episode figures into the retrospective summary. Pure. The
 * typical-gap is withheld (null) below the min-sample floor so a single
 * episode never becomes a "typical" claim.
 */
export function summarizeIllnessRetrospective(
  episodes: RetrospectiveEpisode[],
): IllnessRetrospectiveSummary {
  const byMonth: Record<number, number> = {};
  const byType: Record<string, number> = {};
  let resolvedCount = 0;
  const gaps: number[] = [];

  for (const e of episodes) {
    const month = Number(e.onsetDay.slice(5, 7));
    if (month >= 1 && month <= 12) byMonth[month] = (byMonth[month] ?? 0) + 1;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.resolved) resolvedCount++;
    if (
      e.lifecycle !== "CHRONIC_ONGOING" &&
      e.recoveryGapDays !== null &&
      Number.isFinite(e.recoveryGapDays)
    ) {
      gaps.push(e.recoveryGapDays);
    }
  }

  const typicalRecoveryGapDays =
    gaps.length >= MIN_EPISODES_FOR_TYPICAL_GAP
      ? Math.round(median(gaps))
      : null;

  return {
    episodeCount: episodes.length,
    resolvedCount,
    typicalRecoveryGapDays,
    gapSampleSize: gaps.length,
    byMonth,
    byType,
  };
}
