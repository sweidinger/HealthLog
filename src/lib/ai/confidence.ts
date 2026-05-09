/**
 * v1.4.16 phase B5d — deterministic confidence-score computation per
 * recommendation.
 *
 * Marc's mandate: the model's self-reported confidence is unreliable
 * (calibrated probabilities are not a small-LLM strength), so the
 * wrapper OVERRIDES with a server-computed value derived from three
 * inputs that the cited data window actually exposes:
 *
 *   - n               sample count behind the cited data window
 *                     (`metricSource.n`).
 *   - recencyDays     days since the most recent sample in the window;
 *                     a 7-day rec built off data 25 days old should
 *                     not feel as confident as the same rec built off
 *                     data from this morning.
 *   - deviationStdRatio  |deviation| / stdev of the user's 90-day
 *                     baseline. `null` when the baseline is too thin
 *                     to compute a stdev — we fall back to a neutral
 *                     mid-band score rather than zero.
 *
 * Score components (sum, max 100):
 *
 *   - n contribution: log-saturating curve, capped at 40.
 *     n<3 hard-caps the whole score at ≤15 (5 * n) — three samples is
 *     the hard floor for any quantitative claim per research §2.A
 *     (Apple's "be quiet when unsure" stance).
 *
 *   - recency contribution: 30 at <2d old, decays linearly to 0 at
 *     30d, floored at 0. The shape matches the Oura "Pay Attention"
 *     band — old data is still data, just stale.
 *
 *   - signal contribution: 30 at |z|≥1.5 (clearly out-of-band),
 *     scaled linearly down to 0 at z=0. When ratio is null (no
 *     baseline yet), we award 15 — neither punishing the user for
 *     thin history nor over-claiming a strong deviation we can't
 *     measure.
 *
 * The formula is pre-feedback. v1.4.17 will fit weights to thumbs-up
 * rates (B5e feedback ratchet); for v1.4.16 the formula is fixed and
 * deterministic so admin observability + the "draft pill below 25"
 * UI affordance are reproducible across runs.
 */

export interface ConfidenceInputs {
  /** Sample count behind the cited data window (from metricSource.n). */
  n: number;
  /** Days since the most recent sample in the window. */
  recencyDays: number;
  /** |deviation| / stdev of the user's 90-day baseline, when computable. */
  deviationStdRatio: number | null;
}

const HARD_CAP_FLOOR = 10;
const N_CONTRIBUTION_MAX = 40;
const RECENCY_CONTRIBUTION_MAX = 30;
const RECENCY_DECAY_DAYS = 30;
const SIGNAL_CONTRIBUTION_MAX = 30;
const SIGNAL_SATURATION_RATIO = 1.5;
const SIGNAL_NULL_NEUTRAL = 15;

/**
 * Compute the deterministic confidence score (0..100) for a single
 * recommendation. Pure function — no I/O, no clock; safe to call from
 * test fixtures and from `generateInsight()` post-validation alike.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  const { n, recencyDays, deviationStdRatio } = inputs;

  // n hard cap: <3 samples means we cannot make a quantitative claim,
  // so the whole score is bounded at 5*n (max 15 at n=2). Floor at
  // 10 so n=0/n=1 still produce a non-zero "draft" signal — the UI
  // shows the rec but tags it as low-confidence rather than hiding it.
  if (n < 3) {
    return Math.max(HARD_CAP_FLOOR, 5 * n);
  }

  // n contribution: log10 saturates so a 100-sample window doesn't
  // outweigh a 30-sample window by 3×; both are "enough data" for the
  // user-level signal we care about.
  const nScore = Math.min(N_CONTRIBUTION_MAX, 10 + 10 * Math.log10(n));

  // Recency contribution: <2d ≈ full score (30 * (1 - 0/30) = 30,
  // 30 * (1 - 1/30) = 29; both round into the meter's top band).
  // 30d+ floors to 0 so an ancient window cannot inflate the score.
  const recencyScore = Math.max(
    0,
    RECENCY_CONTRIBUTION_MAX * (1 - recencyDays / RECENCY_DECAY_DAYS),
  );

  // Signal contribution: null ratio (no baseline) → neutral 15.
  // Otherwise scale |z| linearly to the SIGNAL_SATURATION_RATIO cap.
  const signalScore =
    deviationStdRatio === null
      ? SIGNAL_NULL_NEUTRAL
      : Math.min(
          SIGNAL_CONTRIBUTION_MAX,
          SIGNAL_CONTRIBUTION_MAX *
            (Math.abs(deviationStdRatio) / SIGNAL_SATURATION_RATIO),
        );

  return Math.round(nScore + recencyScore + signalScore);
}
