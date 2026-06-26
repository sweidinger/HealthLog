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
 * p, and the BH-adjusted q.
 *
 * v1.21.0 (FDREXTEND) — medication compliance (a daily adherence rate from the
 * compliance engine's dose-history ledger) and symptom severity (the illness
 * day-log functional-impact / symptom-burden track) are now first-class daily
 * channels in the matrix, so the high-value "adherence dip → symptom flare" and
 * "compliance↓ → a vital drifting" links can finally be discovered. They are
 * the sparsest, noisiest inputs in the system — they flow through the SAME
 * n ≥ 20 / p < 0.05 / BH-FDR / effect-size-floor / shrinkage gates as every
 * other channel, so a thin series degrades to absent rather than to a spurious
 * link. The series builders live in `correlation-series-builders.ts`.
 */
import { pearson, MIN_PAIRED_N } from "@/lib/insights/correlations";

/** Default Benjamini-Hochberg target false-discovery rate. */
export const FDR_Q = 0.1;

/**
 * RECON1 (D2-2) — effect-size floor on the SHRUNK |r|. A pair can be
 * statistically significant (p < 0.05, FDR-clean) yet explain a trivial slice
 * of variance — e.g. n=180, r=0.16 explains ~2.5% and is noise-floor signal a
 * human should not chase. Below this floor we DROP the pair from the discovered
 * ranking entirely, so the Coach never narrates a significant-but-trivial pair
 * as a confident "tends to go with" driver. The floor is applied AFTER the D4
 * shrinkage (below), so a thin-data estimate is pulled toward null first.
 */
export const EFFECT_SIZE_FLOOR = 0.2;

/**
 * RECON1 (D2-2 / D2-6) — the |r| at/above which a pair earns CONFIDENT phrasing
 * ("tends to go with"). Between `EFFECT_SIZE_FLOOR` and this, the pair survives
 * but is down-tiered to a hedged "faint hint" so the narrated confidence never
 * outruns the effect.
 */
export const CONFIDENT_EFFECT_THRESHOLD = 0.3;

/**
 * RECON1 (D4) — James-Stein / regression-to-the-mean shrinkage constant. A
 * sparse n-of-1 Pearson estimate is noisy and over-states the effect; we pull
 * it toward null by the factor n/(n+SHRINKAGE_K) before ranking + tiering, so a
 * thin-data correlation cannot out-rank a deep, well-sampled one purely on an
 * inflated point estimate. k=10 means a pair at the n≥20 floor keeps ~67% of
 * its raw r, a 60-day pair keeps ~86%, and a 180-day pair keeps ~95% — light,
 * documented, and reusing nothing more exotic than the paired-day count the
 * MAD-robust baseline infra already surfaces. The shrunk r is used ONLY for
 * ranking, the effect-size floor, and the phrasing tier; the reported `r` and
 * `pValue` stay the honest raw statistics.
 */
export const SHRINKAGE_K = 10;

/**
 * Pull a Pearson r toward null by its sample size (regression-to-the-mean).
 * Pure. Larger n → less shrinkage; a thin pair is discounted toward 0.
 */
export function shrinkEstimate(r: number, n: number): number {
  if (!Number.isFinite(r) || n <= 0) return 0;
  return r * (n / (n + SHRINKAGE_K));
}

/**
 * RECON1 (D2-1) — metric-family key for a discovery channel. Two channels in
 * the same family (e.g. both blood-pressure components) lag-correlate trivially
 * (serial auto-correlation of one physiological signal), so a same-family
 * lagged pair is a near-tautology, not a cross-domain insight. The discovery
 * loop already skips the exact self-pair (`b.key === o.key`); this widens that
 * to the whole family so MOOD→MOOD-class self-lags and any future same-family
 * pairing are excluded from the ranking before they can crowd out genuine
 * cross-domain links. Channels with no shared family return their own key, so
 * only deliberate families collapse.
 */
export function metricFamily(key: string): string {
  // A RATED mood factor (`FACTOR:<name>`) is a sub-component of overall mood, so
  // it shares MOOD's family — a `FACTOR:* → MOOD` lag is the same self-lag
  // tautology as MOOD→MOOD and is excluded too.
  if (key.startsWith(FACTOR_CHANNEL_PREFIX) || key === "MOOD") return "MOOD";
  if (key.startsWith("BLOOD_PRESSURE")) return "BLOOD_PRESSURE";
  // v1.21.0 (FDREXTEND) — medication compliance and symptom severity each form
  // their OWN single-channel family, so the loop's same-family guard collapses
  // only the self-lag (compliance→compliance, symptom→symptom). The returned
  // key equals the channel key for both, so neither shares a family with any
  // vital / sleep / mood channel — they remain free to pair cross-domain
  // (the whole point: adherence↓ → next-day symptom↑, or compliance↓ → a vital
  // drifting). No special-case branch is needed; the `return key` fall-through
  // already isolates them. This comment documents the deliberate decision.
  return key;
}

/** RECON1 (D2-6) — explicit phrasing tier a low-confidence signal must honour. */
export type ConfidenceTier = "high" | "moderate" | "faint";

/**
 * RECON1 (D2-2 / D2-6) — classify a pair into a phrasing tier from its SHRUNK
 * effect size and paired-day depth. The tier is a contract the narration (and
 * the hallucination tests) can check, so a thin / weak signal is hedged
 * differently from a deep / strong one rather than both reading "tends to go
 * with" at full confidence. `null` means below the effect-size floor — the
 * caller drops the pair entirely.
 */
export function confidenceTier(
  shrunkR: number,
  n: number,
): ConfidenceTier | null {
  const mag = Math.abs(shrunkR);
  if (mag < EFFECT_SIZE_FLOOR) return null;
  if (mag < CONFIDENT_EFFECT_THRESHOLD) return "faint";
  // A confident effect still needs depth to be narrated plainly; a strong r on
  // a barely-qualifying sample is "moderate", not "high".
  return n >= 60 ? "high" : "moderate";
}

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
  /**
   * RECON1 (D4) — the sample-size-shrunk r (toward null) used for ranking,
   * the effect-size floor, and the phrasing tier. Display still uses raw `r`.
   */
  shrunkR: number;
  /**
   * RECON1 (D2-6) — phrasing tier the narration must honour: a `faint` signal
   * is hedged, a `high` signal stated plainly. Never `null` here (a below-floor
   * pair is dropped before this list).
   */
  tier: ConfidenceTier;
  /** Conservative, descriptive interpretation — never causal, tier-hedged. */
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
 * Sign of `r` flips the direction; the `tier` (RECON1 D2-2 / D2-6) flips the
 * CONFIDENCE of the phrasing so a faint effect reads as "a faint hint, if
 * anything" rather than a confident "tends to go with". Never claims causation.
 */
function interpret(
  behaviour: string,
  outcome: string,
  r: number,
  tier: ConfidenceTier,
): string {
  const b = humanise(behaviour);
  const o = humanise(outcome);
  const lower = r < 0 ? "lower" : "higher";
  if (tier === "faint") {
    // Below the confident effect-size threshold: a real-but-small signal,
    // hedged so the narrated confidence never outruns the effect.
    return `Higher ${b} shows a faint hint, if anything, of ${lower} next-day ${o} in your data — too small to lean on, never a cause.`;
  }
  const lead =
    tier === "high"
      ? `Higher ${b} tends to go with ${lower} next-day ${o} in your data`
      : `Higher ${b} looks like it goes with ${lower} next-day ${o} in your data, on the evidence so far`;
  return `${lead} — a pattern worth watching, not a cause.`;
}

/**
 * Lower-case, space-separated label from a channel key.
 *
 * v1.14.0 — a `FACTOR:<key>` channel (a RATED mood factor folded into the
 * matrix) strips its namespace prefix so the phrasing reads "rated <factor>"
 * rather than leaking the raw key. The prefix exists only to keep a factor
 * key from colliding with a `MeasurementType` in the channel set.
 */
function humanise(key: string): string {
  if (key.startsWith("FACTOR:")) {
    return `rated ${key.slice("FACTOR:".length).replace(/[_-]/g, " ").toLowerCase()}`;
  }
  return key.replace(/_/g, " ").toLowerCase();
}

/** Namespace prefix for a RATED-mood-factor discovery channel (v1.14.0). */
export const FACTOR_CHANNEL_PREFIX = "FACTOR:";

/**
 * v1.21.0 (FDREXTEND) — stable channel key for the daily medication-compliance
 * adherence rate (per-day taken/scheduled, 0–100). Sourced from the compliance
 * engine's unified dose-history ledger, NOT a `MeasurementType`, so the caller
 * builds its series separately (the way MOOD is read from MoodEntry) and folds
 * it in. A BEHAVIOUR channel: the actionable, high-value direction is
 * "adherence dip today → a worse outcome tomorrow" (next-day symptom flare or a
 * vital drifting), so compliance lags the outcome by a day like every other
 * behaviour. It forms its own `metricFamily`, so the only pair the loop skips is
 * the compliance→compliance self-lag.
 */
export const MEDICATION_COMPLIANCE_CHANNEL_KEY = "MEDICATION_COMPLIANCE";

/**
 * v1.21.0 (FDREXTEND) — stable channel key for the daily symptom-severity /
 * functional-impact burden (0–3; 0 = healthy, 3 = bedbound). Sourced from the
 * illness day-log (`functionalImpact`, else max linked symptom severity), NOT a
 * `MeasurementType`. It rides BOTH roles like MOOD: as an OUTCOME it surfaces
 * "adherence dip today → symptom flare tomorrow"; as a BEHAVIOUR it surfaces
 * "symptom burden today → a vital drifting tomorrow". The same-family guard
 * skips only the symptom→symptom self-lag. The series is built only across the
 * span the user actually logs illness (healthy days inside that span = 0); a
 * user who never logs illness yields an EMPTY series that degrades to absent —
 * never a spurious all-zero constant that could fabricate a link.
 */
export const SYMPTOM_SEVERITY_CHANNEL_KEY = "SYMPTOM_SEVERITY";

/**
 * v1.21.0 (FDREXTEND) — discovery channels that are NOT `MeasurementType` enum
 * values: each is backed by a different model (MOOD → MoodEntry,
 * MEDICATION_COMPLIANCE → the dose-history ledger, SYMPTOM_SEVERITY → the
 * illness day-log). EVERY caller that derives a `MeasurementType[]` list from
 * `DISCOVERY_BEHAVIOURS` / `DISCOVERY_OUTCOMES` to feed a Prisma
 * `measurement.findMany({ where: { type: { in } } })` MUST exclude these — a
 * non-enum string in the `IN (...)` list errors the Postgres enum cast. Use
 * {@link discoveryMeasurementTypes} (or this set) rather than re-spelling the
 * `k !== "MOOD"` filter, so a future non-measurement channel cannot be missed at
 * one call site and crash its query.
 */
export const NON_MEASUREMENT_DISCOVERY_CHANNELS: ReadonlySet<string> = new Set([
  "MOOD",
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  SYMPTOM_SEVERITY_CHANNEL_KEY,
]);

/**
 * v1.21.0 (FDREXTEND) — the subset of `keys` that ARE real `MeasurementType`
 * enum values (i.e. excluding every {@link NON_MEASUREMENT_DISCOVERY_CHANNELS}
 * channel), safe to splice into a Prisma `type IN (...)` filter. The cast is the
 * caller's existing `as MeasurementType[]` assertion — this only drops the
 * non-enum keys first.
 */
export function discoveryMeasurementTypes(keys: readonly string[]): string[] {
  return keys.filter((k) => !NON_MEASUREMENT_DISCOVERY_CHANNELS.has(k));
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
      // RECON1 (D2-1) — skip same-metric-FAMILY lagged pairs, not just the exact
      // self-pair. A same-family lag (mood→mood, sys→any-BP) is a serial
      // auto-correlation tautology, not a cross-domain insight; excluding it
      // before testing stops it crowding out genuine cross-metric links.
      if (metricFamily(b.key) === metricFamily(o.key)) continue;
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
    // RECON1 (D4) — shrink each estimate toward null by its sample depth, then
    // (D2-2) classify into a phrasing tier. A pair below the effect-size floor
    // tiers to `null` and is dropped: it is statistically real but explains too
    // little variance to narrate as a driver.
    .map((t) => {
      const shrunkR = shrinkEstimate(t.r, t.n);
      const tier = confidenceTier(shrunkR, t.n);
      return { ...t, shrunkR, tier };
    })
    .filter(
      (
        t,
      ): t is RawPair & {
        qValue: number;
        shrunkR: number;
        tier: ConfidenceTier;
      } => t.tier !== null,
    )
    .map((t) => ({
      behaviour: t.behaviour,
      outcome: t.outcome,
      n: t.n,
      r: t.r,
      pValue: t.pValue,
      qValue: Math.round(t.qValue * 1000) / 1000,
      shrunkR: Math.round(t.shrunkR * 1000) / 1000,
      tier: t.tier,
      interpretation: interpret(t.behaviour, t.outcome, t.r, t.tier),
      lagDays,
    }))
    // RECON1 (D2-2 / D4) — rank by the SHRUNK effect magnitude (a deep, strong
    // pair leads a thin one even if the thin one's raw r is higher), with q as
    // the tie-break so a tighter FDR still wins on equal effect.
    .sort(
      (a, b) =>
        Math.abs(b.shrunkR) - Math.abs(a.shrunkR) || a.qValue - b.qValue,
    );

  return { discovered, pairsTested, fdrQ, minPairs };
}

/**
 * The curated discovery matrix — the channels the engine pairs. Behaviours
 * (lag sources) on the left, outcomes (lag targets) on the right.
 *
 * v1.21.0 (FDREXTEND) — medication compliance is NOW a behaviour channel (its
 * cadence-aware per-day rate comes from the compliance engine's dose-history
 * ledger; the caller builds the series and folds it in, the way MOOD is read
 * from MoodEntry). Symptom severity rides both roles (see the OUTCOMES note).
 * Both are sparse, noisy inputs — the engine's existing n ≥ 20 / p < 0.05 /
 * BH-FDR / effect-size-floor / shrinkage gates apply UNCHANGED, so a thin
 * compliance or symptom series cannot surface a confident driver.
 */
export const DISCOVERY_BEHAVIOURS = [
  "TIME_IN_DAYLIGHT",
  "MOOD",
  "BLOOD_GLUCOSE",
  "BLOOD_PRESSURE_SYS",
  "ACTIVITY_STEPS",
  // v1.21.0 (FDREXTEND) — daily adherence rate as a lag source: the high-value
  // "adherence dip today → a worse outcome tomorrow" direction.
  MEDICATION_COMPLIANCE_CHANNEL_KEY,
  // v1.21.0 (FDREXTEND) — symptom burden as a lag source too: "more symptomatic
  // today → a vital drifting tomorrow". Mirrored as an outcome below.
  SYMPTOM_SEVERITY_CHANNEL_KEY,
] as const;

export const DISCOVERY_OUTCOMES = [
  "SLEEP_DURATION",
  "HEART_RATE_VARIABILITY",
  "RESTING_HEART_RATE",
  "WEIGHT",
  // v1.11.5 (F3) — mood is now an OUTCOME channel too, not only a behaviour.
  // The discovery loop skips the MOOD→MOOD self-pair (`b.key === o.key`), so
  // promoting it lets the FDR scan surface "behaviour today → next-day mood"
  // relations (e.g. more daylight today → better mood tomorrow) in addition
  // to the existing "mood today → next-day outcome" direction. BH-FDR
  // already controls the larger pair family this opens up.
  "MOOD",
  // v1.21.0 (FDREXTEND) — symptom severity as an OUTCOME: the flagship
  // "adherence dip today → symptom flare tomorrow" link (compliance behaviour →
  // symptom outcome). The same-family guard skips the symptom→symptom self-lag;
  // BH-FDR controls the wider family the dual-role channel opens up.
  SYMPTOM_SEVERITY_CHANNEL_KEY,
  // Wrist temperature is a credible future OUTCOME channel (near-daily, so
  // n ≥ 20 is reachable; "did a hard workout / late alcohol raise next-night
  // temperature?"), but it is deliberately NOT a channel yet: it is
  // privacy-sensitive and deviation-framed, and folding it into the FDR
  // matrix risks surfacing a cycle-phase correlation that strays into
  // reproductive inference. Held pending a deliberate privacy review —
  // documented here so the omission is intentional, not a gap (same posture
  // as the medication-compliance omission above).
] as const;
