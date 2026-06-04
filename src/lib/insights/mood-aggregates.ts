/**
 * v1.8.5 — shared mood-aggregate computation.
 *
 * Single source of truth for the analytics the mood surface needs.
 * `mood-status.ts` (the LLM snapshot builder) and `/api/mood/insights`
 * (the visualization endpoint) both consume these pure functions so the
 * numbers the user sees match the numbers the model reasons over — no
 * drift between the prose and the charts.
 *
 * Everything here is a pure function over already-fetched rows. The DB
 * read + orchestration lives in `fetchMoodAggregates` at the bottom;
 * the per-dimension helpers above it take plain arrays so they unit-test
 * without a database.
 */

import { prisma } from "@/lib/db";
import {
  pearsonCorrelation,
  type CorrelationResult,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import {
  applyPayloadBudget,
  dayOffsetToBerlinDayKey,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
import { round, summarizeSeries } from "@/lib/insights/status-shared";
import { getLocalDateParts } from "@/lib/timezone";
import {
  computeMoodNarratives,
  type MoodNarrative,
} from "@/lib/insights/mood-narratives";
import { welchTTest } from "@/lib/insights/correlations";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse the flat `MoodEntry.tags` JSON string into a string array. The
 * column stores a JSON-encoded array (or null); the read path must
 * decode it before `computeTagSummary`'s `Array.isArray` check, otherwise
 * the flat-tag axis silently collapses to empty (the raw string is never
 * an array). Defensive against malformed JSON — returns `[]` on a parse
 * failure rather than throwing.
 */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Minimal daily-bucket shape the aggregates read. `DailyBucket` (from
 * `bucket-series`) carries an extra `n` field; the helpers only ever
 * touch `dayOffset` + `value`, so accepting the narrow shape keeps them
 * trivially testable without synthesising the unused field.
 */
type DailyPoint = Pick<DailyBucket, "dayOffset" | "value">;

/**
 * A structured tag attached to a mood entry, resolved from the catalog
 * (`mood_tags` + its parent `mood_tag_categories`) via the
 * `mood_entry_tag_links` join. Carried alongside the legacy flat `tags`
 * string so the breakdown can surface both axes.
 */
export interface StructuredTagRef {
  /** Stable tag key (e.g. `happy`). */
  key: string;
  /** Parent category key (e.g. `feelings`). */
  categoryKey: string;
  /** i18n message key for the tag label. */
  labelKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
}

/** Raw mood row shape the aggregates operate on. */
export interface MoodAggregateEntry {
  /** TZ-anchored day key (YYYY-MM-DD). */
  date: string;
  /** Numeric mood score 1..5. */
  score: number;
  /** JSON tag array, or null. */
  tags: unknown;
  /** Exact log timestamp — carries time-of-day. */
  moodLoggedAt: Date;
  /**
   * v1.9.0 — per-row IANA timezone the entry was logged under. Used to
   * bucket `moodLoggedAt` into a part of day in the user's own local
   * time. Optional: legacy rows (`tz IS NULL`) fall back to UTC, mirroring
   * the rollup-tier convention; the legacy aggregate tests keep their
   * narrow fixtures.
   */
  tz?: string | null;
  /**
   * v1.8.5 — structured tags from the taxonomy join. Additive next to
   * the flat `tags`: an entry can carry both. Optional so the legacy
   * aggregate tests (flat tags only) keep their narrow fixtures.
   */
  structuredTags?: StructuredTagRef[];
}

/** Cross-metric row shape (WEIGHT / BLOOD_PRESSURE_SYS / PULSE / …). */
export interface CrossMetricMeasurement {
  type: string;
  value: number;
  measuredAt: Date;
}

// --- Target bands (mirror mood-chart VALUE_BANDS + mood-status) ---

/**
 * The mood-status generator grades "in target" as score >= 3.5. The
 * mood-chart paints three reference bands (1–2 red, 2–3 orange, 3–5
 * green). We keep both anchored here so the heatmap colour map and the
 * in-target headline never drift from the line chart.
 */
export const MOOD_GREEN_MIN = 3.5;
export const MOOD_GREEN_MAX = 5;
export const MOOD_ORANGE_MIN = 2;
export const MOOD_ORANGE_MAX = 3.5;

// --- Pair two daily-bucket series on dayOffset (lifted from mood-status) ---

/**
 * Pair two daily-bucket series on `dayOffset`. The synthesised `date`
 * field is anchored at the UTC midnight of the Berlin calendar day —
 * `dayOffsetToBerlinDayKey()` is the source of truth so DST boundaries
 * don't slip the day-key by one. Each pair also carries `dayKey`
 * directly so callers can label points without re-formatting.
 */
export function pairDailyBuckets(
  seriesA: DailyPoint[],
  seriesB: DailyPoint[],
  now: Date,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToBerlinDayKey(now, entry.dayOffset);
      const [y, m, d] = dayKey.split("-").map(Number);
      return {
        a: entry.value,
        b,
        date: new Date(Date.UTC(y, m - 1, d)),
        dayKey,
      };
    })
    .filter(
      (entry): entry is PairedPoint & { dayKey: string } => entry !== null,
    );
}

// --- Tag frequency + per-tag avg score (lifted from mood-status) ---

export interface TagSummaryRow {
  tag: string;
  count: number;
  avgScore: number;
}

/**
 * Tag frequency + per-tag average mood over a recency window.
 *
 * Keeps the v1.4.5 ~90-day window so the model still gets a recency-
 * weighted view of tag patterns; the caller slices by date, not by
 * record count. Only tags with count >= 2 survive (a single mention is
 * noise), top 10 by frequency.
 */
export function computeTagSummary(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays = 90,
): TagSummaryRow[] {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const tagCounts = new Map<string, { count: number; scoreSum: number }>();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    if (entry.tags && Array.isArray(entry.tags)) {
      for (const tag of entry.tags as string[]) {
        const current = tagCounts.get(tag) ?? { count: 0, scoreSum: 0 };
        current.count += 1;
        current.scoreSum += entry.score;
        tagCounts.set(tag, current);
      }
    }
  }
  return Array.from(tagCounts.entries())
    .filter(([, stats]) => stats.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([tag, stats]) => ({
      tag,
      count: stats.count,
      avgScore: round(stats.scoreSum / stats.count, 2),
    }));
}

// --- Structured-tag frequency + per-tag avg score (v1.8.5 taxonomy) ---

export interface StructuredTagRow {
  key: string;
  categoryKey: string;
  labelKey: string;
  icon: string | null;
  count: number;
  avgScore: number;
}

/**
 * Frequency + per-tag average mood for the structured taxonomy tags,
 * over the same recency window as the flat-tag summary.
 *
 * Unlike `computeTagSummary` (flat free text), singletons are KEPT — a
 * structured tag comes from a curated catalog the user deliberately
 * picked, so a single occurrence is signal, not noise. Ranked by
 * frequency desc, then label key for a stable order. The category key
 * rides along so the UI can group the bars by category with icons.
 */
export function computeStructuredTagSummary(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays = 90,
): StructuredTagRow[] {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const byKey = new Map<
    string,
    {
      categoryKey: string;
      labelKey: string;
      icon: string | null;
      count: number;
      scoreSum: number;
    }
  >();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    if (!entry.structuredTags) continue;
    for (const tag of entry.structuredTags) {
      const current = byKey.get(tag.key) ?? {
        categoryKey: tag.categoryKey,
        labelKey: tag.labelKey,
        icon: tag.icon,
        count: 0,
        scoreSum: 0,
      };
      current.count += 1;
      current.scoreSum += entry.score;
      byKey.set(tag.key, current);
    }
  }
  return Array.from(byKey.entries())
    .map(([key, stats]) => ({
      key,
      categoryKey: stats.categoryKey,
      labelKey: stats.labelKey,
      icon: stats.icon,
      count: stats.count,
      avgScore: round(stats.scoreSum / stats.count, 2),
    }))
    .sort((a, b) => b.count - a.count || a.labelKey.localeCompare(b.labelKey));
}

// --- Tag "Influence on Mood" — with-vs-without daily-mean delta (F1) ---

/**
 * Minimum days a tag must be PRESENT on, and minimum days it must be
 * ABSENT on, before its with/without influence surfaces. Both floors
 * apply: a tag seen on 4 days has no defensible "with" average, and a
 * tag present on all-but-2 days has no defensible "without" baseline.
 * Five days per side is the same order as the stability floor (7 daily
 * points) but per-group — enough for a mean of daily means to mean
 * something without surfacing a two-day fluke as a "factor".
 */
export const INFLUENCE_MIN_PRESENT_DAYS = 5;
export const INFLUENCE_MIN_ABSENT_DAYS = 5;

/**
 * Maximum influence rows surfaced per axis (flat / structured). Ranked by
 * absolute delta so the strongest associations lead; the cap keeps the
 * multiple-comparison surface bounded (the confidence band downgrades the
 * rest honestly).
 */
export const INFLUENCE_MAX_ROWS = 8;

/** Discrete confidence the UI chip renders for an influence row. */
export type InfluenceConfidence = "low" | "medium" | "high";

export interface TagInfluenceRow {
  /** Stable tag key. For flat tags this is the free-text string. */
  tag: string;
  /**
   * For structured tags, the i18n label key + parent category so the UI
   * can render the localized label with its icon. `null` for flat tags
   * (rendered verbatim).
   */
  labelKey: string | null;
  categoryKey: string | null;
  icon: string | null;
  /** Days the tag was present (daily-mean convention). */
  withDays: number;
  /** Days the tag was absent over the same window. */
  withoutDays: number;
  /** Mean of daily means on days the tag was present. */
  withAvg: number;
  /** Mean of daily means on days the tag was absent (the counterfactual). */
  withoutAvg: number;
  /** withAvg − withoutAvg, rounded. Positive = higher mood with the tag. */
  delta: number;
  /**
   * Pooled mood SD across the with/without groups (Cohen's-d denominator).
   * `null` when neither group has testable spread (both constant). Lets the
   * board standardize the raw delta into a unitless effect comparable to a
   * Pearson |r|. Not surfaced in the UI — ranking only.
   */
  pooledSd: number | null;
  /** Welch two-sided p-value for the difference of means. */
  pValue: number;
  /** Discrete confidence band derived from p-value + per-group sample size. */
  confidence: InfluenceConfidence;
}

/**
 * Map a Welch p-value + the smaller per-group day count to a discrete
 * confidence band. Both inputs matter: a small p on tiny groups is still
 * fragile, and a comfortable sample with a borderline p is only suggestive.
 *
 * - high   : p < 0.01 AND both groups ≥ 12 days
 * - medium : p < 0.05 AND both groups ≥ 8 days
 * - low    : everything else that cleared the surfacing floors
 *
 * The deterministic "no_variance" case (both groups perfectly constant but
 * with a non-zero delta) is treated as `low` — a real but un-tested
 * difference should never read as confident.
 */
export function influenceConfidence(
  pValue: number,
  minGroupDays: number,
): InfluenceConfidence {
  if (pValue < 0.01 && minGroupDays >= 12) return "high";
  if (pValue < 0.05 && minGroupDays >= 8) return "medium";
  return "low";
}

/**
 * Collapse raw mood rows to one observation per tz-anchored day: the
 * day's mean score plus the union of every flat + structured tag key
 * present on any entry that day. Daily-mean convention so a multi-entry
 * day never over-weights an influence comparison (it matches the heatmap,
 * distribution, and weekday axes).
 */
interface TaggedDay {
  /** Day's mean mood (mean of the day's entry scores). */
  mean: number;
  /** Flat free-text tag keys present that day. */
  flatTags: Set<string>;
  /** Structured tag refs present that day, keyed for de-dup. */
  structuredTags: Map<string, StructuredTagRef>;
}

function collapseToTaggedDays(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays: number,
): Map<string, TaggedDay> {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const byDay = new Map<
    string,
    { sum: number; count: number; flat: Set<string>; structured: Map<string, StructuredTagRef> }
  >();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    const day = byDay.get(entry.date) ?? {
      sum: 0,
      count: 0,
      flat: new Set<string>(),
      structured: new Map<string, StructuredTagRef>(),
    };
    day.sum += entry.score;
    day.count += 1;
    if (entry.tags && Array.isArray(entry.tags)) {
      for (const tag of entry.tags as string[]) day.flat.add(tag);
    }
    if (entry.structuredTags) {
      for (const ref of entry.structuredTags) day.structured.set(ref.key, ref);
    }
    byDay.set(entry.date, day);
  }
  const out = new Map<string, TaggedDay>();
  for (const [date, agg] of byDay) {
    out.set(date, {
      mean: agg.sum / agg.count,
      flatTags: agg.flat,
      structuredTags: agg.structured,
    });
  }
  return out;
}

/**
 * Compute the with-vs-without influence row for ONE candidate tag over a
 * pre-collapsed day map. `presentOn(day)` decides membership. Returns null
 * when either group is below its day floor (so the caller drops the tag)
 * or when Welch reports no testable spread AND the means are equal.
 */
function influenceForTag(
  days: TaggedDay[],
  presentOn: (day: TaggedDay) => boolean,
  meta: { tag: string; labelKey: string | null; categoryKey: string | null; icon: string | null },
): TagInfluenceRow | null {
  const withVals: number[] = [];
  const withoutVals: number[] = [];
  for (const day of days) {
    if (presentOn(day)) withVals.push(day.mean);
    else withoutVals.push(day.mean);
  }
  if (
    withVals.length < INFLUENCE_MIN_PRESENT_DAYS ||
    withoutVals.length < INFLUENCE_MIN_ABSENT_DAYS
  ) {
    return null;
  }

  const welch = welchTTest(withVals, withoutVals);

  // Deterministic means even when Welch declines (no_variance) — the
  // delta is still meaningful, we just cannot attach a p-value, so the
  // band falls to `low`.
  const withAvg = withVals.reduce((s, v) => s + v, 0) / withVals.length;
  const withoutAvg =
    withoutVals.reduce((s, v) => s + v, 0) / withoutVals.length;
  const delta = withAvg - withoutAvg;
  const minGroupDays = Math.min(withVals.length, withoutVals.length);

  // Pooled SD (Cohen's-d denominator) so the board can standardize this raw
  // mood-point delta into a unitless effect comparable to a Pearson |r|.
  // Unbiased (n−1) per-group variances pooled on (nWith + nWithout − 2) df;
  // null when there is no testable spread (both groups perfectly constant).
  const nWith = withVals.length;
  const nWithout = withoutVals.length;
  const varWith =
    withVals.reduce((s, v) => s + (v - withAvg) ** 2, 0) / (nWith - 1);
  const varWithout =
    withoutVals.reduce((s, v) => s + (v - withoutAvg) ** 2, 0) /
    (nWithout - 1);
  const pooledVar =
    ((nWith - 1) * varWith + (nWithout - 1) * varWithout) /
    (nWith + nWithout - 2);
  const pooledSd = pooledVar > 0 ? Math.sqrt(pooledVar) : null;

  const pValue = welch.status === "ok" ? welch.pValue : 1;
  // A zero delta with no spread is not an "influence" — drop it so the
  // board never shows a 0.0 row.
  if (delta === 0) return null;

  return {
    tag: meta.tag,
    labelKey: meta.labelKey,
    categoryKey: meta.categoryKey,
    icon: meta.icon,
    withDays: withVals.length,
    withoutDays: withoutVals.length,
    withAvg: round(withAvg, 2),
    withoutAvg: round(withoutAvg, 2),
    delta: round(delta, 2),
    pooledSd: pooledSd === null ? null : round(pooledSd, 3),
    pValue,
    confidence: influenceConfidence(pValue, minGroupDays),
  };
}

export interface TagInfluence {
  /** Flat free-text tag influence rows, ranked by |delta| desc. */
  flat: TagInfluenceRow[];
  /** Structured taxonomy tag influence rows, ranked by |delta| desc. */
  structured: TagInfluenceRow[];
}

/**
 * Tag "Influence on Mood" (Daylio's flagship): for each frequent flat and
 * structured tag, the average daily mood on days the tag is PRESENT vs the
 * counterfactual baseline of days it is ABSENT, the delta, and a confidence
 * band from a Welch two-sample t-test.
 *
 * Gating: both groups must clear `INFLUENCE_MIN_PRESENT_DAYS` /
 * `INFLUENCE_MIN_ABSENT_DAYS`; rows are ranked by absolute delta and capped
 * at `INFLUENCE_MAX_ROWS` per axis. Observational only — the UI applies the
 * standing "association, not cause" caption. Sparse tags, single-day tags,
 * all-same-value days, and divide-by-zero are all handled cleanly (the row
 * is dropped, never NaN).
 */
export function computeTagInfluence(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays = 90,
): TagInfluence {
  const dayMap = collapseToTaggedDays(entries, now, windowDays);
  const days = Array.from(dayMap.values());

  // Need at least one day per side to even attempt — the per-tag floor
  // catches the real gate, this just short-circuits an empty history.
  if (days.length < INFLUENCE_MIN_PRESENT_DAYS + INFLUENCE_MIN_ABSENT_DAYS) {
    return { flat: [], structured: [] };
  }

  // Candidate flat tags: every distinct flat key seen in the window.
  const flatKeys = new Set<string>();
  for (const day of days) for (const k of day.flatTags) flatKeys.add(k);

  const flat: TagInfluenceRow[] = [];
  for (const key of flatKeys) {
    const row = influenceForTag(days, (d) => d.flatTags.has(key), {
      tag: key,
      labelKey: null,
      categoryKey: null,
      icon: null,
    });
    if (row) flat.push(row);
  }

  // Candidate structured tags: every distinct structured key + its meta.
  const structuredMeta = new Map<string, StructuredTagRef>();
  for (const day of days) {
    for (const [key, ref] of day.structuredTags) {
      if (!structuredMeta.has(key)) structuredMeta.set(key, ref);
    }
  }

  const structured: TagInfluenceRow[] = [];
  for (const [key, ref] of structuredMeta) {
    const row = influenceForTag(days, (d) => d.structuredTags.has(key), {
      tag: key,
      labelKey: ref.labelKey,
      categoryKey: ref.categoryKey,
      icon: ref.icon,
    });
    if (row) structured.push(row);
  }

  const rank = (a: TagInfluenceRow, b: TagInfluenceRow) =>
    Math.abs(b.delta) - Math.abs(a.delta) || a.tag.localeCompare(b.tag);

  return {
    flat: flat.sort(rank).slice(0, INFLUENCE_MAX_ROWS),
    structured: structured.sort(rank).slice(0, INFLUENCE_MAX_ROWS),
  };
}

// --- "What's associated with your better days" board (F2) ---

/**
 * One ranked factor on the unified board. Either a tag (`source: "tag"`,
 * effect = the mood-point delta) or a health-metric correlation
 * (`source: "metric"`, effect = Pearson r). Direction tells the UI whether
 * the factor goes with higher or lower mood; the standing "association, not
 * cause" caption is rendered once for the whole board.
 */
export interface BetterDayFactor {
  source: "tag" | "metric";
  /** Tag key OR correlation channel key (sleep/steps/pulse/weight/bp). */
  key: string;
  /** Flat tags / metrics: null. Structured tags: the i18n label key. */
  labelKey: string | null;
  categoryKey: string | null;
  icon: string | null;
  /** "up" = associated with higher mood; "down" = with lower mood. */
  direction: "up" | "down";
  /** Sample count behind the factor (tag: smaller group; metric: paired n). */
  n: number;
  /** Discrete confidence band. */
  confidence: InfluenceConfidence;
  /**
   * Unified ranking strength in [0,1]. For metrics this is |r|; for tags it
   * is min(1, |delta| / 2) — a two-point mood swing reads as full strength.
   * Ranking only; the UI surfaces the raw delta / r, not this number.
   */
  effectSize: number;
  /** Raw mood-point delta for a tag factor; null for a metric factor. */
  delta: number | null;
  /** Raw Pearson r for a metric factor; null for a tag factor. */
  r: number | null;
}

/** Max factors on the board so the headline surface stays scannable. */
export const BETTER_DAYS_MAX_FACTORS = 8;

/** Map a metric correlation strength label to the shared confidence band. */
function metricConfidence(
  strength: CorrelationResult["strength"],
): InfluenceConfidence {
  if (strength === "stark") return "high";
  if (strength === "moderat") return "medium";
  return "low";
}

/**
 * Merge the F1 tag influence rows and the mood × health-metric
 * correlations into one effect-size-ranked, confidence-gated board.
 *
 * Inclusion gates (multiple-comparison aware):
 *  - Tag rows: already gated by `computeTagInfluence` (sample floors +
 *    Welch); included as-is.
 *  - Metric rows: only correlations that reached `n ≥ 5` AND carry a
 *    non-"keine" strength (|r| ≥ 0.2) are folded in — a near-zero r is not
 *    an association.
 *
 * Ranking is by `effectSize` desc, then confidence, then key for stability.
 * The two sources are put on one comparable scale: metric rows use |r|
 * (already unitless in [0,1]); tag rows use a standardized effect — the raw
 * mood-point `delta` divided by the pooled with/without mood SD (Cohen's d),
 * clamped to [0,1]. A |d| ≥ 1 (a mean shift of one full SD) saturates the
 * scale, mirroring an |r| near its ceiling, so neither source dominates the
 * board for scale reasons alone. When a tag has no pooled SD (both groups
 * perfectly constant), it falls back to the legacy |delta|/2 heuristic — a
 * rare degenerate case that can't be standardized. The raw delta / r the UI
 * shows is unchanged; this only governs the sort order. Observational only.
 */
export function computeBetterDays(
  tagInfluence: TagInfluence,
  correlations: Record<CorrelationKey, MoodMetricCorrelation>,
): BetterDayFactor[] {
  const factors: BetterDayFactor[] = [];

  // Tag factors (both axes). Structured tags carry their label meta.
  for (const row of [...tagInfluence.structured, ...tagInfluence.flat]) {
    factors.push({
      source: "tag",
      key: row.tag,
      labelKey: row.labelKey,
      categoryKey: row.categoryKey,
      icon: row.icon,
      direction: row.delta >= 0 ? "up" : "down",
      n: Math.min(row.withDays, row.withoutDays),
      confidence: row.confidence,
      // Cohen's-d standardization so the tag effect is commensurable with a
      // metric |r|; fall back to the legacy |delta|/2 only when the pooled
      // SD is unavailable (both groups perfectly constant).
      effectSize:
        row.pooledSd && row.pooledSd > 0
          ? Math.min(1, Math.abs(row.delta) / row.pooledSd)
          : Math.min(1, Math.abs(row.delta) / 2),
      delta: row.delta,
      r: null,
    });
  }

  // Metric factors — only meaningful, sufficiently-sampled correlations.
  for (const [key, corr] of Object.entries(correlations)) {
    const result = corr.result;
    if (!result || corr.n < 5) continue;
    if (result.strength === "keine") continue;
    factors.push({
      source: "metric",
      key,
      labelKey: null,
      categoryKey: null,
      icon: null,
      // Mood is the x-axis: positive r = higher metric on higher-mood days,
      // i.e. the metric is associated with higher mood.
      direction: result.r >= 0 ? "up" : "down",
      n: corr.n,
      confidence: metricConfidence(result.strength),
      effectSize: Math.min(1, Math.abs(result.r)),
      delta: null,
      r: result.r,
    });
  }

  const confidenceRank: Record<InfluenceConfidence, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  return factors
    .sort(
      (a, b) =>
        b.effectSize - a.effectSize ||
        confidenceRank[b.confidence] - confidenceRank[a.confidence] ||
        a.key.localeCompare(b.key),
    )
    .slice(0, BETTER_DAYS_MAX_FACTORS);
}

// --- In-target % over the last 30 daily points (lifted from mood-status) ---

/**
 * Share (0..100) of the newest 30 daily mood buckets that land in the
 * green band (>= 3.5). Returns null when there is no recent data.
 */
export function computeInTargetPct(daily: DailyPoint[]): number | null {
  const recent = daily.filter((bucket) => bucket.dayOffset < 30);
  if (recent.length === 0) return null;
  const inTarget = recent.filter(
    (entry) => entry.value >= MOOD_GREEN_MIN && entry.value <= MOOD_GREEN_MAX,
  ).length;
  return round((inTarget / recent.length) * 100, 1);
}

// --- Mood distribution (share per discrete level) ---

export interface DistributionRow {
  /** Rounded mood level 1..5. */
  score: number;
  count: number;
}

/**
 * Distribution of daily-mean mood across the five discrete levels.
 *
 * Open product question #2 (design §7) resolves to the daily-mean
 * convention used everywhere else on the surface: each day contributes
 * one observation, its mean rounded to the nearest level. This keeps
 * multi-entry days from over-weighting the histogram and matches the
 * heatmap (one cell per day).
 */
export function computeDistribution(daily: DailyPoint[]): DistributionRow[] {
  const counts = new Map<number, number>();
  for (const bucket of daily) {
    const level = Math.min(5, Math.max(1, Math.round(bucket.value)));
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const rows: DistributionRow[] = [];
  for (let score = 1; score <= 5; score++) {
    rows.push({ score, count: counts.get(score) ?? 0 });
  }
  return rows;
}

// --- Average mood by weekday ---

export interface WeekdayRow {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  avgScore: number | null;
  count: number;
}

/**
 * Average daily-mean mood grouped by weekday (Monday = 0). The weekday
 * is read off the day-key in UTC so it matches the heatmap's UTC-anchored
 * Monday alignment (`compliance-heatmap` reads `getUTCDay`).
 */
export function computeWeekdayAverages(
  daily: DailyPoint[],
  now: Date,
): WeekdayRow[] {
  const sums = new Map<number, { sum: number; count: number }>();
  for (const bucket of daily) {
    const dayKey = dayOffsetToBerlinDayKey(now, bucket.dayOffset);
    const d = new Date(dayKey + "T00:00:00Z");
    const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
    const cur = sums.get(weekday) ?? { sum: 0, count: 0 };
    cur.sum += bucket.value;
    cur.count += 1;
    sums.set(weekday, cur);
  }
  const rows: WeekdayRow[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const agg = sums.get(weekday);
    rows.push({
      weekday,
      avgScore: agg ? round(agg.sum / agg.count, 2) : null,
      count: agg?.count ?? 0,
    });
  }
  return rows;
}

// --- Time-of-day pattern (tz-aware part-of-day buckets) ---

/** Part-of-day bucket key. Order is morning → night for stable rendering. */
export type TimeOfDayBucket = "morning" | "afternoon" | "evening" | "night";

/** Ordered bucket list — drives both the chart x-axis and the iteration. */
export const TIME_OF_DAY_BUCKETS: readonly TimeOfDayBucket[] = [
  "morning",
  "afternoon",
  "evening",
  "night",
] as const;

/**
 * Minimum entries a single bucket must hold before it counts toward the
 * pattern. A lone log in a bucket is noise, not a daypart preference.
 */
export const TIME_OF_DAY_MIN_BUCKET_SAMPLES = 3;

/**
 * Minimum distinct populated buckets (each at or above the per-bucket
 * sample floor) before the pattern surfaces at all. The guard against the
 * once-a-day logger: a nightly Telegram check-in clusters in a single
 * bucket, which can never clear a two-bucket spread, so the "you feel
 * best in the morning" takeaway never fires misleadingly.
 */
export const TIME_OF_DAY_MIN_SPREAD = 2;

/**
 * Map a local hour-of-day (0..23) to its part-of-day bucket.
 *
 * morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–20:59,
 * night 21:00–04:59. The boundaries follow the common Daylio / consumer
 * convention; night wraps midnight so a 02:00 log lands in `night`.
 */
export function bucketForHour(hour: number): TimeOfDayBucket {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export interface TimeOfDayRow {
  bucket: TimeOfDayBucket;
  avgScore: number | null;
  count: number;
}

export interface TimeOfDayPattern {
  /** All four buckets, in canonical order; unpopulated buckets carry null. */
  buckets: TimeOfDayRow[];
  /**
   * Whether the spread + sample floors are cleared — i.e. the pattern is
   * trustworthy enough to surface a chart and a takeaway. False for the
   * once-a-day logger (everything in one bucket) or a sparse history.
   */
  reliable: boolean;
  /** Best / worst bucket keys when `reliable`; null otherwise. */
  best: TimeOfDayBucket | null;
  worst: TimeOfDayBucket | null;
}

/**
 * Average mood per part of day, bucketed in each entry's own timezone.
 *
 * `moodLoggedAt` carries the exact instant; `tz` (per-row IANA) anchors
 * the local hour. Legacy rows without a `tz` fall back to UTC — the same
 * convention the rollup tier uses for `tz IS NULL` mood rows. Every entry
 * (not the daily mean) feeds its bucket, because the question is "what
 * time of day do I feel best", which a daily collapse would erase.
 *
 * The `reliable` flag is the once-a-day-logger guard: it only trips when
 * at least `TIME_OF_DAY_MIN_SPREAD` buckets each carry
 * `TIME_OF_DAY_MIN_BUCKET_SAMPLES` entries. `best`/`worst` are computed
 * over the populated-and-sufficient buckets only.
 */
export function computeTimeOfDayAverages(
  entries: MoodAggregateEntry[],
): TimeOfDayPattern {
  const sums = new Map<TimeOfDayBucket, { sum: number; count: number }>();
  for (const entry of entries) {
    const tz = entry.tz ?? "UTC";
    const { hour } = getLocalDateParts(entry.moodLoggedAt, tz);
    const bucket = bucketForHour(hour);
    const cur = sums.get(bucket) ?? { sum: 0, count: 0 };
    cur.sum += entry.score;
    cur.count += 1;
    sums.set(bucket, cur);
  }

  const buckets: TimeOfDayRow[] = TIME_OF_DAY_BUCKETS.map((bucket) => {
    const agg = sums.get(bucket);
    return {
      bucket,
      avgScore: agg ? round(agg.sum / agg.count, 2) : null,
      count: agg?.count ?? 0,
    };
  });

  const sufficient = buckets.filter(
    (row): row is TimeOfDayRow & { avgScore: number } =>
      row.avgScore != null && row.count >= TIME_OF_DAY_MIN_BUCKET_SAMPLES,
  );
  const reliable = sufficient.length >= TIME_OF_DAY_MIN_SPREAD;

  let best: TimeOfDayBucket | null = null;
  let worst: TimeOfDayBucket | null = null;
  if (reliable) {
    let bestRow = sufficient[0];
    let worstRow = sufficient[0];
    for (const row of sufficient) {
      if (row.avgScore > bestRow.avgScore) bestRow = row;
      if (row.avgScore < worstRow.avgScore) worstRow = row;
    }
    best = bestRow.bucket;
    worst = worstRow.bucket;
  }

  return { buckets, reliable, best, worst };
}

// --- Mood stability score (variance of daily means → 0..100) ---

/**
 * Minimum distinct daily points before a stability score is computed. A
 * handful of days has no meaningful variance signal, so a sparse logger
 * gets `null` (no tile, no sentence) rather than a noisy number.
 */
export const STABILITY_MIN_DAYS = 7;

/**
 * The full-scale standard deviation that maps to a 0 stability score. The
 * mood scale spans 1..5, so the widest day-to-day swing is 4 points; a
 * population SD at or above this is treated as maximally unstable. Below
 * it, the score scales linearly toward 100 (perfectly steady).
 */
export const STABILITY_SD_FULL_SCALE = 1.5;

export type StabilityBand = "verySteady" | "steady" | "variable" | "veryVariable";

export interface MoodStability {
  /** 0..100; higher = steadier (lower day-to-day variance). */
  score: number;
  /** Population standard deviation of the daily means (raw, for tests). */
  stdDev: number;
  /** Descriptive, non-judgemental band. */
  band: StabilityBand;
  /** Daily points the score was computed over. */
  days: number;
}

/**
 * Map a 0..100 stability score to a four-band descriptive label.
 * Descriptive, not judgemental — some variation is healthy (Oura framing),
 * so the bands read "steady" / "variable", never "good" / "bad".
 */
function stabilityBand(score: number): StabilityBand {
  if (score >= 80) return "verySteady";
  if (score >= 60) return "steady";
  if (score >= 40) return "variable";
  return "veryVariable";
}

/**
 * Mood-stability score from the population standard deviation of the
 * daily means.
 *
 * Formula:
 *   sd    = sqrt( mean( (x_i - mean(x))^2 ) )         // population SD
 *   score = round( 100 * (1 - min(sd, FULL) / FULL) ) // clamped 0..100
 *
 * A flat mood (sd = 0) scores 100; an sd at or beyond
 * `STABILITY_SD_FULL_SCALE` scores 0. Returns `null` below
 * `STABILITY_MIN_DAYS` distinct daily points so a sparse logger never
 * gets a meaningless score.
 */
export function computeMoodStability(daily: DailyPoint[]): MoodStability | null {
  if (daily.length < STABILITY_MIN_DAYS) return null;

  const values = daily.map((bucket) => bucket.value);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  const normalised = Math.min(stdDev, STABILITY_SD_FULL_SCALE) / STABILITY_SD_FULL_SCALE;
  const score = Math.round(100 * (1 - normalised));

  return {
    score,
    stdDev: round(stdDev, 3),
    band: stabilityBand(score),
    days: daily.length,
  };
}

// --- Heatmap (one cell per day, score band per cell) ---

export type HeatmapWindowDays = 30 | 90 | 365;

/**
 * Adaptive heatmap window so the grid is never mostly-empty.
 *
 * - < 90 days of history → 30-day window (a fresh logger sees a dense
 *   month, not a sparse year).
 * - 90..180 days → 90-day window.
 * - > 180 days → 365-day "year in pixels" (Daylio parity).
 *
 * `historyDays` is the span between the oldest and newest entry.
 */
export function selectHeatmapWindow(historyDays: number): HeatmapWindowDays {
  if (historyDays > 180) return 365;
  if (historyDays >= 90) return 90;
  return 30;
}

export interface HeatmapCell {
  /** YYYY-MM-DD day key. */
  date: string;
  /** Daily-mean mood score for the day. */
  score: number;
  /** Number of entries that fed the mean. */
  samples: number;
}

/**
 * Build the per-day heatmap cells from raw mood rows. One cell per day
 * key carrying the daily mean (multi-entry days averaged), restricted to
 * the adaptive window.
 */
export function computeHeatmapCells(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays: HeatmapWindowDays,
): HeatmapCell[] {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    const cur = byDay.get(entry.date) ?? { sum: 0, count: 0 };
    cur.sum += entry.score;
    cur.count += 1;
    byDay.set(entry.date, cur);
  }
  return Array.from(byDay.entries())
    .map(([date, stats]) => ({
      date,
      score: round(stats.sum / stats.count, 2),
      samples: stats.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- Cross-metric correlation (lifted from mood-status) ---

export interface CorrelationScatterPoint {
  x: number;
  y: number;
  /** Index signature so the point satisfies the chart's
   * `Record<string, number>` data constraint. */
  [key: string]: number;
}

export interface MoodMetricCorrelation {
  result: CorrelationResult | null;
  /** Mood (x) vs metric (y) scatter points, paired by day. */
  points: CorrelationScatterPoint[];
  n: number;
}

/**
 * Pearson correlation between the mood daily series and one metric daily
 * series, paired on `dayOffset`. Returns the scatter points so the
 * caller can paint a `<ScatterCorrelationChart>` from the same pairing
 * the coefficient was computed over.
 */
export function computeMoodMetricCorrelation(
  moodDaily: DailyPoint[],
  metricDaily: DailyPoint[],
  now: Date,
): MoodMetricCorrelation {
  const pairs = pairDailyBuckets(moodDaily, metricDaily, now);
  const result = pearsonCorrelation(pairs);
  const points = pairs.map((p) => ({ x: p.a, y: p.b }));
  return { result, points, n: pairs.length };
}

// --- Orchestrated aggregate shape ---

/**
 * v1.8.5 — the cross-metric channels the mood page correlates against,
 * mapping the correlation key the UI reads to its measurement type. This
 * is the single source for both the `correlations` object below and the
 * `fetchMoodAggregates` measurement `in:[...]` filter, so the two can
 * never drift out of sync.
 */
export const CORRELATION_METRICS = {
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  pulse: "PULSE",
  weight: "WEIGHT",
  bloodPressureSystolic: "BLOOD_PRESSURE_SYS",
} as const;

type CorrelationKey = keyof typeof CORRELATION_METRICS;

export interface MoodAggregates {
  summary: {
    points: number;
    mean: number | null;
    min: number | null;
    max: number | null;
    latest: number | null;
    /** latest daily mean minus the previous daily mean. */
    delta: number | null;
    inTargetPct: number | null;
    totalEntries: number;
    totalSpanDays: number;
    newestEntryDaysAgo: number | null;
  };
  heatmap: {
    windowDays: HeatmapWindowDays;
    cells: HeatmapCell[];
  };
  distribution: DistributionRow[];
  weekday: WeekdayRow[];
  /**
   * v1.9.0 — average mood per part of day, bucketed in each entry's own
   * timezone. `reliable` gates the chart + takeaway against the once-a-day
   * logger (everything in one bucket).
   */
  timeOfDay: TimeOfDayPattern;
  /**
   * v1.9.0 — day-to-day stability score (0..100, higher = steadier) plus a
   * descriptive band. `null` for a sparse logger (< STABILITY_MIN_DAYS).
   */
  stability: MoodStability | null;
  tags: TagSummaryRow[];
  /** v1.8.5 — structured-tag breakdown from the taxonomy join. */
  structuredTags: StructuredTagRow[];
  /**
   * v1.11.5 (F1) — tag "Influence on Mood": with-vs-without daily-mean
   * delta + Welch confidence band for each frequent flat / structured tag.
   */
  tagInfluence: TagInfluence;
  /**
   * v1.11.5 (F2) — unified "what's associated with your better days" board
   * folding the F1 tag deltas and the mood × health-metric correlations
   * into one effect-size-ranked, confidence-gated, observational list.
   */
  betterDays: BetterDayFactor[];
  /**
   * v1.8.6 — ranked, threshold-gated narrative takeaways. The "read
   * this first" layer above the charts; the same array feeds the LLM
   * snapshot so prose and feed never drift.
   */
  narratives: MoodNarrative[];
  correlations: Record<CorrelationKey, MoodMetricCorrelation>;
}

/**
 * Compute every mood aggregate from already-fetched rows. Pure — no DB
 * access — so callers (the endpoint and the unit tests) control the
 * fetch + the clock.
 */
export function computeMoodAggregates(args: {
  entries: MoodAggregateEntry[];
  measurements: CrossMetricMeasurement[];
  now: Date;
}): MoodAggregates {
  const { entries, measurements, now } = args;

  const moodPoints = entries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodPoints, { now });
  const moodDaily = moodSeries.daily;

  const moodSummary = summarizeSeries(
    moodDaily.map((bucket) => ({ value: bucket.value })),
  );

  // daily[0] = newest bucket (lowest dayOffset).
  const latest = moodDaily[0] ?? null;
  const previous = moodDaily[1] ?? null;

  const oldestEntry = entries.length > 0 ? entries[0].moodLoggedAt : null;
  const newestEntry =
    entries.length > 0 ? entries[entries.length - 1].moodLoggedAt : null;
  const totalSpanDays =
    oldestEntry && newestEntry
      ? Math.round((newestEntry.getTime() - oldestEntry.getTime()) / MS_PER_DAY)
      : 0;
  const newestEntryDaysAgo = newestEntry
    ? Math.round((now.getTime() - newestEntry.getTime()) / MS_PER_DAY)
    : null;

  const metricDaily = (type: string) =>
    applyPayloadBudget(
      measurements
        .filter((m) => m.type === type)
        .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
      { now },
    ).daily;

  const windowDays = selectHeatmapWindow(totalSpanDays);

  const weekday = computeWeekdayAverages(moodDaily, now);
  const timeOfDay = computeTimeOfDayAverages(entries);
  const stability = computeMoodStability(moodDaily);
  const tags = computeTagSummary(entries, now);
  const structuredTags = computeStructuredTagSummary(entries, now);
  const tagInfluence = computeTagInfluence(entries, now);
  const inTargetPct = computeInTargetPct(moodDaily);

  const correlations = Object.fromEntries(
    Object.entries(CORRELATION_METRICS).map(([key, type]) => [
      key,
      computeMoodMetricCorrelation(moodDaily, metricDaily(type), now),
    ]),
  ) as MoodAggregates["correlations"];

  const betterDays = computeBetterDays(tagInfluence, correlations);

  // Distinct day keys the user logged on — drives the streak takeaway.
  const loggedDayKeys = Array.from(new Set(entries.map((entry) => entry.date)));

  return {
    summary: {
      points: moodSummary?.points ?? 0,
      mean: moodSummary?.mean ?? null,
      min: moodSummary?.min ?? null,
      max: moodSummary?.max ?? null,
      latest: latest?.value ?? null,
      delta:
        latest && previous ? round(latest.value - previous.value, 2) : null,
      inTargetPct,
      totalEntries: entries.length,
      totalSpanDays,
      newestEntryDaysAgo,
    },
    heatmap: {
      windowDays,
      cells: computeHeatmapCells(entries, now, windowDays),
    },
    distribution: computeDistribution(moodDaily),
    weekday,
    timeOfDay,
    stability,
    tags,
    structuredTags,
    tagInfluence,
    betterDays,
    narratives: computeMoodNarratives({
      daily: moodDaily,
      weekday,
      timeOfDay,
      tags,
      structuredTags,
      inTargetPct,
      loggedDayKeys,
      now,
    }),
    correlations,
  };
}

/**
 * DB read + orchestration for the mood-insights endpoint.
 *
 * Bounded reads mirror the mood-status path: 365 days of mood rows (the
 * heatmap window never exceeds a year) and 365 days × 5 cross-metric
 * channels. Tombstoned rows are excluded so the analytics match the
 * line chart.
 */
export async function fetchMoodAggregates(
  userId: string,
  now: Date = new Date(),
): Promise<MoodAggregates> {
  const windowCutoff = new Date(now.getTime() - 365 * MS_PER_DAY);

  const entries = await prisma.moodEntry
    .findMany({
      where: { userId, deletedAt: null, moodLoggedAt: { gte: windowCutoff } },
      orderBy: { moodLoggedAt: "desc" },
      take: 2000,
      select: {
        date: true,
        score: true,
        tags: true,
        moodLoggedAt: true,
        // v1.9.0 — per-row IANA tz anchors the part-of-day bucketing in
        // the user's local time (legacy null rows fall back to UTC).
        tz: true,
        // v1.8.5 — pull the structured-tag links + their catalog rows so
        // the breakdown can fold structured tags next to the flat ones.
        tagLinks: {
          select: {
            moodTag: {
              select: {
                key: true,
                labelKey: true,
                icon: true,
                category: { select: { key: true } },
              },
            },
          },
        },
      },
    })
    .then((rows) =>
      rows.reverse().map((row) => ({
        date: row.date,
        score: row.score,
        tags: parseTags(row.tags),
        moodLoggedAt: row.moodLoggedAt,
        tz: row.tz,
        structuredTags: row.tagLinks.map((link) => ({
          key: link.moodTag.key,
          categoryKey: link.moodTag.category.key,
          labelKey: link.moodTag.labelKey,
          icon: link.moodTag.icon,
        })),
      })),
    );

  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        deletedAt: null,
        measuredAt: { gte: windowCutoff },
        // v1.8.5 — single-sourced from CORRELATION_METRICS so the fetched
        // channels and the computed correlations never drift apart.
        type: { in: Object.values(CORRELATION_METRICS) },
      },
      orderBy: { measuredAt: "desc" },
      take: 5000,
      select: { type: true, value: true, measuredAt: true },
    })
    .then((rows) => rows.reverse());

  return computeMoodAggregates({ entries, measurements, now });
}
