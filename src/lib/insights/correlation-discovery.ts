/**
 * v1.10.0 — FDR-controlled correlation discovery engine.
 *
 * Promotes the legacy three-fixed-hypothesis `correlations.ts` to a bounded
 * ALL-PAIRS discovery over a curated behaviour × outcome matrix, lagged
 * (a behaviour on day D vs an outcome on day D+1), Benjamini-Hochberg
 * FDR-controlled on top of the existing exact Student-t / n ≥ 20 / p < 0.05
 * gates. Only statistically-defensible pairs surface, each with an honest
 * "descriptive, not causal" caveat.
 *
 * Why FDR: scanning many pairs inflates the family-wise false-discovery
 * rate — at p < 0.05 alone, 1-in-20 noise pairs surface as "significant".
 * Benjamini & Hochberg (1995), J. R. Stat. Soc. B 57(1):289–300 controls
 * the expected proportion of false discoveries among the surfaced pairs to
 * `FDR_Q` (default 0.10). A pair surfaces only when its rank-adjusted q
 * clears the threshold — so the card count stays honest as the matrix grows.
 *
 * Lagging: a behaviour (today's daylight, mood, glucose, BP) is paired with
 * the NEXT day's outcome (sleep, HRV, resting HR, weight). The lag encodes
 * the plausible direction ("more daylight today → better sleep tonight")
 * without claiming causation — the caveat is displayed verbatim.
 *
 * Pearson + the exact incomplete-beta p-value are reused from
 * `src/lib/insights/correlations.ts` (its docstring explicitly anticipates
 * this auto-discovery widening the pair grid). This module is PURE over
 * already-fetched daily series — the DB read lives in the route.
 *
 * Framing discipline: descriptive, never causal; every pair carries n, r,
 * p, and the BH-adjusted q; medication compliance is NOT yet a behaviour
 * channel (the cadence-aware per-day rate needs the compliance engine — a
 * later wave), documented here so the omission is intentional, not a gap.
 */
import { pearson, MIN_PAIRED_N } from "@/lib/insights/correlations";

/** Default Benjamini-Hochberg target false-discovery rate. */
export const FDR_Q = 0.1;

/** A single day's value for one metric (daily mean / sum). */
export interface DailySeriesPoint {
  /** Day key YYYY-MM-DD. */
  day: string;
  value: number;
}

/** A named daily series feeding the discovery matrix. */
export interface NamedSeries {
  /** Stable channel key (e.g. "TIME_IN_DAYLIGHT", "MOOD"). */
  key: string;
  /** Whether the channel is a behaviour (lag source) or an outcome (lag target). */
  role: "behaviour" | "outcome";
  points: DailySeriesPoint[];
}

/** One discovered, FDR-surviving correlation pair. */
export interface DiscoveredCorrelation {
  behaviour: string;
  outcome: string;
  /** Paired-day count after the day+1 lag join. */
  n: number;
  /** Pearson r (lag-joined). */
  r: number;
  /** Two-sided exact Student-t p-value. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value. */
  qValue: number;
  /** Conservative, descriptive interpretation — never causal. */
  interpretation: string;
  /** Lag in days applied (always 1 here). */
  lagDays: number;
}

export interface CorrelationDiscoveryResult {
  /** Pairs surviving n ≥ 20, p < 0.05, AND the BH-FDR control. */
  discovered: DiscoveredCorrelation[];
  /** How many behaviour × outcome pairs were tested (for the honest footer). */
  pairsTested: number;
  /** The FDR target the surface used. */
  fdrQ: number;
  /** Minimum paired-day count enforced per pair. */
  minPairs: number;
}

/** Add `lagDays` to a YYYY-MM-DD day key, returning the shifted key. */
function shiftDay(day: string, lagDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + lagDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * Lag-join a behaviour series (day D) against an outcome series (day D+lag).
 * Returns the paired (behaviour, outcome) value arrays. Pure.
 */
export function lagJoin(
  behaviour: DailySeriesPoint[],
  outcome: DailySeriesPoint[],
  lagDays: number,
): { xs: number[]; ys: number[] } {
  const outcomeByDay = new Map(outcome.map((p) => [p.day, p.value]));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of behaviour) {
    const target = outcomeByDay.get(shiftDay(b.day, lagDays));
    if (target != null && Number.isFinite(b.value) && Number.isFinite(target)) {
      xs.push(b.value);
      ys.push(target);
    }
  }
  return { xs, ys };
}

interface RawPair {
  behaviour: string;
  outcome: string;
  n: number;
  r: number;
  pValue: number;
}

/**
 * Apply the Benjamini-Hochberg step-up procedure to a set of p-values.
 * Returns the BH-adjusted q-value per input index (monotone-enforced from
 * the largest rank down), so a caller can surface pairs whose q ≤ `fdrQ`.
 * Pure. `m` is the number of tests (the full family), which can exceed
 * `pValues.length` if some pairs were dropped before ranking — but here we
 * pass every tested pair, so `m === pValues.length`.
 */
export function benjaminiHochberg(
  pValues: number[],
  m: number = pValues.length,
): number[] {
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);
  const q = new Array<number>(pValues.length);
  // Walk from the largest p (rank m) down, enforcing monotonicity so a
  // smaller p never gets a larger q than a larger p.
  let prev = 1;
  for (let rank = indexed.length; rank >= 1; rank--) {
    const { p, i } = indexed[rank - 1];
    const raw = (p * m) / rank;
    prev = Math.min(prev, raw);
    q[i] = Math.min(1, prev);
  }
  return q;
}

/**
 * Build a conservative, descriptive interpretation for a surviving pair.
 * Sign of `r` flips the phrasing; never claims causation.
 */
function interpret(behaviour: string, outcome: string, r: number): string {
  const b = humanise(behaviour);
  const o = humanise(outcome);
  if (r <= -0.1) {
    return `Higher ${b} tends to go with lower next-day ${o} in your data — a pattern worth watching, not a cause.`;
  }
  if (r >= 0.1) {
    return `Higher ${b} tends to go with higher next-day ${o} in your data — a pattern worth watching, not a cause.`;
  }
  return `${b} and next-day ${o} move together only weakly in this window.`;
}

/** Lower-case, space-separated label from a channel key. */
function humanise(key: string): string {
  return key.replace(/_/g, " ").toLowerCase();
}

/**
 * Run the FDR-controlled discovery over the behaviour × outcome matrix.
 *
 * 1. For every (behaviour, outcome) pair, lag-join (D → D+1) and run
 *    Pearson with the exact p-value. Pairs below `minPairs` paired days
 *    are dropped (not tested — they cannot be defensibly assessed).
 * 2. Across the tested pairs, compute BH q-values.
 * 3. Surface pairs with p < 0.05 AND q ≤ `fdrQ`, ranked by q then |r|.
 *
 * Pure — the caller fetches the daily series.
 */
export function discoverCorrelations(
  series: NamedSeries[],
  opts: { lagDays?: number; minPairs?: number; fdrQ?: number } = {},
): CorrelationDiscoveryResult {
  const lagDays = opts.lagDays ?? 1;
  const minPairs = opts.minPairs ?? MIN_PAIRED_N;
  const fdrQ = opts.fdrQ ?? FDR_Q;

  const behaviours = series.filter((s) => s.role === "behaviour");
  const outcomes = series.filter((s) => s.role === "outcome");

  const tested: RawPair[] = [];
  for (const b of behaviours) {
    for (const o of outcomes) {
      if (b.key === o.key) continue;
      const { xs, ys } = lagJoin(b.points, o.points, lagDays);
      if (xs.length < minPairs) continue;
      const result = pearson({ xs, ys, minPairs });
      if (result.status !== "ok") continue;
      tested.push({
        behaviour: b.key,
        outcome: o.key,
        n: result.n,
        r: result.r,
        pValue: result.pValue,
      });
    }
  }

  const pairsTested = tested.length;
  if (pairsTested === 0) {
    return { discovered: [], pairsTested: 0, fdrQ, minPairs };
  }

  const qValues = benjaminiHochberg(tested.map((t) => t.pValue));
  const discovered: DiscoveredCorrelation[] = tested
    .map((t, i) => ({ ...t, qValue: qValues[i] }))
    .filter((t) => t.pValue < 0.05 && t.qValue <= fdrQ)
    .map((t) => ({
      behaviour: t.behaviour,
      outcome: t.outcome,
      n: t.n,
      r: t.r,
      pValue: t.pValue,
      qValue: Math.round(t.qValue * 1000) / 1000,
      interpretation: interpret(t.behaviour, t.outcome, t.r),
      lagDays,
    }))
    .sort((a, b) => a.qValue - b.qValue || Math.abs(b.r) - Math.abs(a.r));

  return { discovered, pairsTested, fdrQ, minPairs };
}

/**
 * The curated discovery matrix — the channels the engine pairs. Behaviours
 * (lag sources) on the left, outcomes (lag targets) on the right. Medication
 * compliance is deliberately NOT yet a behaviour channel — its cadence-aware
 * per-day rate needs the compliance engine; folding it in is a later wave.
 */
export const DISCOVERY_BEHAVIOURS = [
  "TIME_IN_DAYLIGHT",
  "MOOD",
  "BLOOD_GLUCOSE",
  "BLOOD_PRESSURE_SYS",
  "ACTIVITY_STEPS",
] as const;

export const DISCOVERY_OUTCOMES = [
  "SLEEP_DURATION",
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "WEIGHT",
] as const;
