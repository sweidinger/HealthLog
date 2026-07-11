/**
 * Tag analytics for the mood surface: frequency + per-tag average mood
 * on both axes (flat free-text and the structured taxonomy) plus the
 * tag "Influence on Mood" board — with-vs-without daily-mean deltas,
 * Welch-tested, confidence-banded.
 *
 * Extracted verbatim from `mood-aggregates.ts`, which re-exports this
 * module so every existing call site keeps importing from the hub.
 * Everything here is a pure function over already-fetched rows; the DB
 * read + orchestration stay in the hub's `fetchMoodAggregates`.
 */

import { welchTTest } from "@/lib/insights/correlations";
import { round } from "@/lib/insights/status-shared";
import { MS_PER_DAY } from "@/lib/time-constants";
import type {
  MoodAggregateEntry,
  StructuredTagRef,
} from "@/lib/insights/mood-aggregates";

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
  /** Decrypted custom-tag label; null for catalogue tags (see `StructuredTagRef`). */
  label?: string | null;
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
      label: string | null;
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
        label: tag.label ?? null,
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
      label: stats.label,
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
  /** Decrypted custom-tag label; null for catalogue / flat tags. */
  label?: string | null;
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
export interface TaggedDay {
  /** Day's mean mood (mean of the day's entry scores). */
  mean: number;
  /** Flat free-text tag keys present that day. */
  flatTags: Set<string>;
  /** Structured tag refs present that day, keyed for de-dup. */
  structuredTags: Map<string, StructuredTagRef>;
}

export function collapseToTaggedDays(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays: number,
): Map<string, TaggedDay> {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const byDay = new Map<
    string,
    {
      sum: number;
      count: number;
      flat: Set<string>;
      structured: Map<string, StructuredTagRef>;
    }
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
  meta: {
    tag: string;
    labelKey: string | null;
    label: string | null;
    categoryKey: string | null;
    icon: string | null;
  },
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
    withoutVals.reduce((s, v) => s + (v - withoutAvg) ** 2, 0) / (nWithout - 1);
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
    label: meta.label,
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
      label: null,
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
      label: ref.label ?? null,
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
