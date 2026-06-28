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
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  computeMoodNarratives,
  type MoodNarrative,
} from "@/lib/insights/mood-narratives";
import { welchTTest } from "@/lib/insights/correlations";
import { benjaminiHochberg as fdrAdjust } from "@/lib/insights/correlation-discovery";
import { resolveUserTimezone, toBerlinYmd } from "@/lib/tz/resolver";
import { annotate } from "@/lib/logging/context";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { createCustomLabelResolver } from "@/lib/mood/custom-tags";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import type { MeasurementType } from "@/generated/prisma/enums";
import type { MeasurementSource } from "@/generated/prisma/client";

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
  /**
   * v1.16.11 — decrypted free-text label for a per-user custom tag
   * (`custom:` key), resolved server-side. `null` / absent for catalogue
   * tags, whose `labelKey` resolves via i18n — a custom tag's `labelKey`
   * just mirrors its key, so without this field every insights surface
   * renders the raw `custom:<uuid>`. Renderers use `label ?? t(labelKey)`.
   */
  label?: string | null;
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
  /**
   * v1.14.0 — per-entry RATED factor scores (work / sleep-quality /
   * stress …) from the same `mood_entry_tag_links` join, but carrying the
   * numeric `rating` instead of a present/absent flag. Optional so legacy
   * fixtures keep their narrow shape. A RATED factor is a *continuous*
   * daily signal, fed into the factor crosstab (low-vs-high-day vital
   * deviation) and the discovery matrix — distinct from BINARY structured
   * tags, which carry no `rating`.
   */
  ratedFactors?: RatedFactorScore[];
}

/**
 * A RATED mood factor's score on a single entry, resolved from the
 * catalog. Carries the scale + `inverse` flag so the analytics layer can
 * apply the documented sign-flip ("higher rating = worse day" → flip so
 * "up" always reads as better) once, at the series boundary.
 */
export interface RatedFactorScore {
  /** Stable factor key (e.g. `work`). */
  key: string;
  /** Parent category key. */
  categoryKey: string;
  /** i18n message key for the factor label. */
  labelKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
  /** The per-entry rating, bounded to `scaleMin..scaleMax` at ingest. */
  rating: number;
  /** Inclusive scale bounds (default 1..5). */
  scaleMin: number;
  scaleMax: number;
  /**
   * `true` when a higher rating means a WORSE day (stress / conflict).
   * The series builder flips an inverse factor's rating to
   * `(scaleMin + scaleMax) - rating` so "up" always reads as better.
   */
  inverse: boolean;
}

/**
 * Cross-metric row shape (WEIGHT / BLOOD_PRESSURE_SYS / PULSE / …).
 *
 * `source` / `deviceType` are optional so the correlation fixtures and
 * legacy single-source tests keep their narrow shape, but when present
 * they feed the crosstab's canonical-source pick: a cumulative metric
 * (steps / active energy / sleep) that two sources both report for the
 * same day must resolve to ONE source before summing, or the per-day
 * total double-counts (see `metricDayMap`). The picker keys off
 * `source` (the ladder axis) and `deviceType` (the watch>phone>scale
 * axis) exactly like the analytics steps/sleep path.
 */
export interface CrossMetricMeasurement {
  type: string;
  value: number;
  measuredAt: Date;
  source?: MeasurementSource | null;
  deviceType?: string | null;
}

/**
 * v1.12.1 — cap on the cross-metric measurement read in
 * `fetchMoodAggregates`. Sized to keep a full data-rich 365-day window
 * intact rather than the old flat 5,000 which silently dropped the
 * oldest months (the read is `measuredAt desc`) once a multi-source,
 * high-frequency user (per-stage sleep + per-sample pulse/HRV across
 * Apple + Fitbit + WHOOP) blew past it. The crosstab/correlation only
 * need per-day values, but the read stays raw because the DAY rollup
 * buckets on UTC midnight while these aggregates key on the user's
 * Berlin calendar day — see the read comment. Exported so the read's
 * `take` and the truncation-annotation threshold share one constant.
 */
export const MOOD_CROSS_METRIC_ROW_CAP = 50_000;

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
  tz: string = DEFAULT_TIMEZONE,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToBerlinDayKey(now, entry.dayOffset, tz);
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
  /** Decrypted custom-tag label; null for catalogue / flat / metric rows. */
  label?: string | null;
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
      label: row.label ?? null,
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
      label: null,
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

// --- Tag × health-metric crosstab (v1.12.0) ------------------------------

/**
 * v1.12.0 — per-tag × health-metric crosstab.
 *
 * Daylio's "Activities & Mood" board answers "how does my mood differ on
 * days I tagged X?". This extends the same with-vs-without comparison to a
 * health METRIC: for each structured mood tag present on enough days, the
 * metric's mean on tag-present days vs tag-absent days, the delta, the
 * Welch two-sided p, and a confidence band — reusing the EXACT statistics
 * engine the F1 tag-influence board already runs (`welchTTest` +
 * `influenceConfidence` + the per-group day floors). FDR-corrected across
 * every tested (tag × metric) pair via the shared `benjaminiHochberg`
 * step-up so the surface stays honest as the matrix grows.
 *
 * Pairing modes:
 *  - "sameDay" — the metric on the SAME day the tag was logged. Used for
 *    activity (a workout/active tag × ACTIVE_ENERGY_BURNED) and sleep (a
 *    sleep tag × SLEEP_DURATION).
 *  - "nextDay" — the metric on the day AFTER the tag (D → D+1 lag join, the
 *    same lag the correlation-discovery engine uses). Used for an
 *    alcohol/food tag × next-day recovery/readiness (RECOVERY_SCORE),
 *    where the plausible direction is "tonight's choice → tomorrow's
 *    recovery".
 *
 * Observational only — the UI renders the standing "association, not
 * cause" caption once. The metric value is shown in its display unit
 * (SLEEP_DURATION minutes → hours; energy kcal; recovery score 0..100).
 */
/** Default Benjamini-Hochberg target FDR for the crosstab family. */
export const CROSSTAB_FDR_Q = 0.1;

/**
 * Per-side day floors for the crosstab — kept in step with the influence
 * floors (`INFLUENCE_MIN_PRESENT_DAYS` / `INFLUENCE_MIN_ABSENT_DAYS`) so a tag
 * needs the same defensible present/absent support before a metric delta
 * surfaces. Declared independently so the crosstab surface owns its own floor.
 */
export const CROSSTAB_MIN_PRESENT_DAYS = 5;
export const CROSSTAB_MIN_ABSENT_DAYS = 5;

/** Max rows surfaced across the whole crosstab so the surface stays scannable. */
export const CROSSTAB_MAX_ROWS = 8;

type CrosstabMode = "sameDay" | "nextDay";

/**
 * The metric channels the crosstab pairs each tag against. The `display`
 * key drives unit formatting on the client; `mode` fixes the pairing lag.
 * Single-sourced so the fetch filter (`CROSSTAB_METRIC_TYPES`) and the
 * compute can never drift.
 */
export const CROSSTAB_METRICS: Record<
  string,
  {
    type: MeasurementType;
    mode: CrosstabMode;
    display: "hours" | "kcal" | "score";
  }
> = {
  // A workout / active tag × same-day active energy.
  activeEnergy: {
    type: "ACTIVE_ENERGY_BURNED",
    mode: "sameDay",
    display: "kcal",
  },
  // A sleep tag × same-night sleep duration (stored minutes → hours on UI).
  sleepDuration: { type: "SLEEP_DURATION", mode: "sameDay", display: "hours" },
  // An alcohol / food tag × next-day recovery/readiness (D → D+1 lag).
  nextDayRecovery: {
    type: "RECOVERY_SCORE",
    mode: "nextDay",
    display: "score",
  },
} as const;

export type CrosstabMetricKey = keyof typeof CROSSTAB_METRICS;

/** Distinct measurement types the crosstab reads — single-sourced. */
export const CROSSTAB_METRIC_TYPES: MeasurementType[] = Array.from(
  new Set(Object.values(CROSSTAB_METRICS).map((m) => m.type)),
);

export interface TagMetricCrosstabRow {
  /** Stable structured-tag key. */
  tag: string;
  /** i18n label key for the tag (structured tags only — never flat). */
  labelKey: string;
  /** Decrypted custom-tag label; null for catalogue tags. */
  label?: string | null;
  /** Parent category key, for grouping/icon. */
  categoryKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
  /** Which metric channel this row compares against. */
  metricKey: CrosstabMetricKey;
  /** Display unit hint for the client formatter. */
  display: "hours" | "kcal" | "score";
  /** Pairing mode used (echoed so the UI can caption "next-day"). */
  mode: CrosstabMode;
  /** Days the tag was present that had a paired metric value. */
  withDays: number;
  /** Days the tag was absent that had a paired metric value. */
  withoutDays: number;
  /** Mean metric on tag-present days (display unit). */
  withAvg: number;
  /** Mean metric on tag-absent days (display unit). */
  withoutAvg: number;
  /** withAvg − withoutAvg (display unit). */
  delta: number;
  /** Welch two-sided p-value for the difference of means. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value across the tested family. */
  qValue: number;
  /** Discrete confidence band (p + min per-group day count). */
  confidence: InfluenceConfidence;
}

const CROSSTAB_SUM_TYPES = new Set<string>([
  "ACTIVE_ENERGY_BURNED",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
]);

/** Berlin-calendar day key (`YYYY-MM-DD`) for a row's `measuredAt`. */
function berlinDayKey(measuredAt: Date): string {
  const { year, month, day } = toBerlinYmd(measuredAt);
  return `${year}-${month}-${day}`;
}

/**
 * Build a Berlin-day-keyed metric map with the right aggregation. Energy
 * and step totals are SUMMED per day (HealthKit `stats:` rows are already
 * one daily-total row, so the sum is the total either way); sleep duration
 * is SUMMED across per-stage rows to get the night total; everything else
 * (a once-daily score) is MEANED. Returns minutes/kcal/raw — the display
 * conversion happens at row-build time.
 *
 * Cross-source de-dup: before bucketing, the rows for this metric run
 * through the SAME canonical-source picker the analytics steps/sleep path
 * uses (`pickCanonicalSourceRows`, keyed by `metricKeyForType` + the
 * Berlin day key). Without it, the moment two sources report the same day
 * (Fitbit + Apple steps, Fitbit + WHOOP sleep) the SUM channels would
 * double-count and bias the Welch delta. The picker collapses each day to
 * one source (and one device-type within it), so the sum reflects one
 * stream. MEAN channels (a once-daily score like recovery) gain the same
 * single-source guarantee for free. Rows without a `source` (the legacy
 * test fixtures, or a metric whose source isn't in the ladder) fall
 * through the picker's pass-through branch unchanged.
 */
export function metricDayMap(
  measurements: CrossMetricMeasurement[],
  type: string,
  userPriorityJson: unknown,
): Map<string, number> {
  const summed = CROSSTAB_SUM_TYPES.has(type);

  const typeRows = measurements.filter((m) => m.type === type);
  if (typeRows.length === 0) return new Map();

  // Resolve the canonical source per day. `metricKeyForType` maps the
  // crosstab's MeasurementType to its priority ladder; a metric with no
  // ladder (or rows without a source) keeps every row via the picker's
  // documented pass-through fallback, so behaviour is identical to the
  // pre-fix sum for single-source data.
  const metricKey = metricKeyForType(type as MeasurementType);
  const canonicalRows = metricKey
    ? pickCanonicalSourceRows(
        typeRows.map((m) => ({
          measuredAt: m.measuredAt,
          source: (m.source ?? "MANUAL") as MeasurementSource,
          deviceType: m.deviceType ?? null,
          type: type as MeasurementType,
          value: m.value,
        })),
        metricKey,
        userPriorityJson,
        berlinDayKey,
      ).canonicalRows
    : typeRows;

  const byDay = new Map<string, { sum: number; count: number }>();
  for (const m of canonicalRows) {
    const key = berlinDayKey(m.measuredAt);
    const cur = byDay.get(key) ?? { sum: 0, count: 0 };
    cur.sum += m.value;
    cur.count += 1;
    byDay.set(key, cur);
  }
  const out = new Map<string, number>();
  for (const [key, agg] of byDay) {
    out.set(key, summed ? agg.sum : agg.sum / agg.count);
  }
  return out;
}

/** Add `lagDays` to a YYYY-MM-DD day key (UTC-anchored, DST-immune). */
export function shiftDayKey(day: string, lagDays: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + lagDays);
  return dt.toISOString().slice(0, 10);
}

/** Convert a raw metric value to the row's display unit. */
function toDisplayUnit(
  value: number,
  display: "hours" | "kcal" | "score",
): number {
  return display === "hours" ? value / 60 : value;
}

interface CrosstabCandidate {
  row: Omit<TagMetricCrosstabRow, "qValue">;
}

/**
 * Compute the tag × metric crosstab. Pure over already-fetched rows.
 *
 * For every structured tag and every configured metric channel, collapse
 * the window to one observation per tz-anchored day (the tag's daily
 * membership) joined to the metric's per-day value (same-day or D+1). The
 * tag-present and tag-absent metric samples feed `welchTTest`; rows that
 * clear both day floors are tested, FDR-corrected as one family, and the
 * survivors (p < 0.05 AND q ≤ `CROSSTAB_FDR_Q`) surface ranked by q then
 * |delta|.
 *
 * Structured tags only — flat free-text tags are excluded because the
 * crosstab needs a stable, localized label and a curated-catalog tag is
 * the right granularity for a metric comparison.
 */
export function computeTagMetricCrosstab(args: {
  entries: MoodAggregateEntry[];
  measurements: CrossMetricMeasurement[];
  now: Date;
  windowDays?: number;
  /**
   * The user's source-priority blob. Threaded into `metricDayMap` so the
   * per-day canonical-source pick honours the user's ladder. `null` (the
   * test default) resolves to the default ladders.
   */
  userPriorityJson?: unknown;
}): TagMetricCrosstabRow[] {
  const { entries, measurements, now } = args;
  const windowDays = args.windowDays ?? 365;
  const userPriorityJson = args.userPriorityJson ?? null;

  const dayMap = collapseToTaggedDays(entries, now, windowDays);
  if (dayMap.size === 0) return [];

  // The set of structured tags seen in the window, with their meta.
  const structuredMeta = new Map<string, StructuredTagRef>();
  for (const day of dayMap.values()) {
    for (const [key, ref] of day.structuredTags) {
      if (!structuredMeta.has(key)) structuredMeta.set(key, ref);
    }
  }
  if (structuredMeta.size === 0) return [];

  const candidates: CrosstabCandidate[] = [];

  for (const [metricKey, cfg] of Object.entries(CROSSTAB_METRICS) as Array<
    [CrosstabMetricKey, (typeof CROSSTAB_METRICS)[CrosstabMetricKey]]
  >) {
    const metricByDay = metricDayMap(measurements, cfg.type, userPriorityJson);
    if (metricByDay.size === 0) continue;

    for (const [tagKey, ref] of structuredMeta) {
      const withVals: number[] = [];
      const withoutVals: number[] = [];
      for (const [dayKey, day] of dayMap) {
        const metricKeyDay =
          cfg.mode === "nextDay" ? shiftDayKey(dayKey, 1) : dayKey;
        const metricValue = metricByDay.get(metricKeyDay);
        if (metricValue == null || !Number.isFinite(metricValue)) continue;
        const display = toDisplayUnit(metricValue, cfg.display);
        if (day.structuredTags.has(tagKey)) withVals.push(display);
        else withoutVals.push(display);
      }

      if (
        withVals.length < CROSSTAB_MIN_PRESENT_DAYS ||
        withoutVals.length < CROSSTAB_MIN_ABSENT_DAYS
      ) {
        continue;
      }

      const welch = welchTTest(withVals, withoutVals);
      const withAvg = withVals.reduce((s, v) => s + v, 0) / withVals.length;
      const withoutAvg =
        withoutVals.reduce((s, v) => s + v, 0) / withoutVals.length;
      const delta = withAvg - withoutAvg;
      if (delta === 0) continue;

      const pValue = welch.status === "ok" ? welch.pValue : 1;
      const minGroupDays = Math.min(withVals.length, withoutVals.length);

      candidates.push({
        row: {
          tag: tagKey,
          labelKey: ref.labelKey,
          label: ref.label ?? null,
          categoryKey: ref.categoryKey,
          icon: ref.icon,
          metricKey,
          display: cfg.display,
          mode: cfg.mode,
          withDays: withVals.length,
          withoutDays: withoutVals.length,
          withAvg: round(withAvg, 2),
          withoutAvg: round(withoutAvg, 2),
          delta: round(delta, 2),
          pValue,
          confidence: influenceConfidence(pValue, minGroupDays),
        },
      });
    }
  }

  if (candidates.length === 0) return [];

  // FDR-correct across the whole tested family (every tag × metric pair) so
  // the multiple-comparison surface stays honest as the matrix grows. Reuses
  // the same Benjamini-Hochberg step-up the correlation-discovery engine runs.
  const qValues = fdrAdjust(candidates.map((c) => c.row.pValue));

  return candidates
    .map((c, i) => ({ ...c.row, qValue: Math.round(qValues[i] * 1000) / 1000 }))
    .filter((row) => row.pValue < 0.05 && row.qValue <= CROSSTAB_FDR_Q)
    .sort(
      (a, b) =>
        a.qValue - b.qValue ||
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.tag.localeCompare(b.tag),
    )
    .slice(0, CROSSTAB_MAX_ROWS);
}

// --- RATED factor × health-metric crosstab (low- vs high-factor days) ---

/**
 * v1.14.0 — the flagship cross-domain insight: "on days you rated <factor>
 * low, your <vital> ran X below baseline".
 *
 * A RATED mood factor (work / sleep-quality / stress …) is a CONTINUOUS
 * per-day score, unlike the BINARY structured tags `computeTagMetricCrosstab`
 * handles. To reuse the EXACT same Welch + FDR engine, this thresholds the
 * factor's daily mean into a binary membership — a day is "low" when its
 * factor mean sits BELOW the factor's own median over the window, "high" at
 * or above. The median split is robust + self-calibrating (always two
 * non-empty groups when the factor has spread), and invents no fixed cutoff.
 *
 * `inverse` is applied at the SERIES boundary (the factor's per-day mean is
 * flipped to `(scaleMin + scaleMax) - raw` for an inverse factor like
 * stress), so the median split — and therefore the "low day" label — always
 * means "a worse day for this factor", honestly, without per-call casing.
 *
 * Same honesty discipline as the tag crosstab: both sides need
 * `CROSSTAB_MIN_PRESENT_DAYS` / `CROSSTAB_MIN_ABSENT_DAYS` paired metric
 * days, the family is BH-FDR corrected as one (across every factor × metric
 * × direction pair), survivors clear p < 0.05 AND q ≤ `CROSSTAB_FDR_Q`, and
 * the surface is capped + ranked. Observational only — the card renders the
 * standing "association, not cause" caption.
 */

/**
 * The metric channels the factor crosstab pairs each RATED factor against.
 * Broader than the tag crosstab (which is activity-focused) because the
 * value of a RATED factor is its bridge from a SUBJECTIVE score to an
 * OBJECTIVE vital. `sameDay` for same-night/same-day metrics (sleep,
 * steps); `nextDay` (D → D+1) for overnight-recovery metrics (RHR / HRV),
 * matching the plausible "today's factor → tomorrow's body" direction.
 */
export const FACTOR_CROSSTAB_METRICS: Record<
  string,
  {
    type: MeasurementType;
    mode: CrosstabMode;
    display: "hours" | "score" | "steps" | "bpm" | "ms" | "kg" | "mmHg";
  }
> = {
  sleepDuration: { type: "SLEEP_DURATION", mode: "sameDay", display: "hours" },
  steps: { type: "ACTIVITY_STEPS", mode: "sameDay", display: "steps" },
  restingHeartRate: {
    type: "RESTING_HEART_RATE",
    mode: "nextDay",
    display: "bpm",
  },
  heartRateVariability: {
    type: "HEART_RATE_VARIABILITY",
    mode: "nextDay",
    display: "ms",
  },
  weight: { type: "WEIGHT", mode: "sameDay", display: "kg" },
  bloodPressureSystolic: {
    type: "BLOOD_PRESSURE_SYS",
    mode: "sameDay",
    display: "mmHg",
  },
} as const;

export type FactorCrosstabMetricKey = keyof typeof FACTOR_CROSSTAB_METRICS;

/** Distinct measurement types the factor crosstab reads — single-sourced. */
export const FACTOR_CROSSTAB_METRIC_TYPES: MeasurementType[] = Array.from(
  new Set(Object.values(FACTOR_CROSSTAB_METRICS).map((m) => m.type)),
);

export interface FactorMetricCrosstabRow {
  /** Stable RATED-factor key. */
  factor: string;
  /** i18n label key for the factor. */
  labelKey: string;
  /** Parent category key, for grouping/icon. */
  categoryKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
  /**
   * `true` when the factor is inverse-scaled (stress / conflict). The
   * UI flips the phrasing — "your worse <factor> days" — but the split
   * itself already runs on the flipped series, so a "low" row always
   * means a worse day regardless.
   */
  inverse: boolean;
  /** Which metric channel this row compares against. */
  metricKey: FactorCrosstabMetricKey;
  /** Display unit hint for the client formatter. */
  display: FactorMetricDisplay;
  /** Pairing mode used (echoed so the UI can caption "next-day"). */
  mode: CrosstabMode;
  /** Days the factor was rated LOW (below its median) with a paired metric. */
  lowDays: number;
  /** Days the factor was rated HIGH (at/above its median) with a paired metric. */
  highDays: number;
  /** Mean metric on low-factor days (display unit). */
  lowAvg: number;
  /** Mean metric on high-factor days (display unit). */
  highAvg: number;
  /** lowAvg − highAvg (display unit). Negative = vital runs lower on low days. */
  delta: number;
  /** Welch two-sided p-value for the difference of means. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value across the tested family. */
  qValue: number;
  /** Discrete confidence band (p + min per-group day count). */
  confidence: InfluenceConfidence;
}

type FactorMetricDisplay =
  (typeof FACTOR_CROSSTAB_METRICS)[FactorCrosstabMetricKey]["display"];

/** Convert a raw metric value to its factor-crosstab display unit. */
function toFactorDisplayUnit(
  value: number,
  display: FactorMetricDisplay,
): number {
  return display === "hours" ? value / 60 : value;
}

/** Median of a numeric array (sorted-copy, mean-of-two for even length). */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Reference data for one RATED factor's daily series + its meta. */
interface FactorDailySeries {
  ref: Pick<
    RatedFactorScore,
    "key" | "labelKey" | "categoryKey" | "icon" | "inverse"
  >;
  /** Day key → factor's daily-mean score, inverse-flipped if needed. */
  byDay: Map<string, number>;
}

/**
 * Build a per-factor daily-mean series, applying the `inverse` sign-flip
 * once. For each tz-anchored day, the mean of the factor's ratings across
 * the day's entries; an inverse factor's rating `r` maps to
 * `(scaleMin + scaleMax) - r` BEFORE averaging so "up" always reads as a
 * better day. Pure. Exported for the discovery-channel path (period
 * narrative) so the two consumers can never diverge on the flip.
 */
export function buildFactorDailySeries(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays: number,
): Map<string, FactorDailySeries> {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const acc = new Map<
    string,
    {
      ref: FactorDailySeries["ref"];
      byDay: Map<string, { sum: number; count: number }>;
    }
  >();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    if (!entry.ratedFactors) continue;
    for (const f of entry.ratedFactors) {
      if (!Number.isFinite(f.rating)) continue;
      // The documented sign-flip: an inverse factor's rating is mirrored
      // across its scale midpoint so a higher series value always means a
      // better day. Done here, once, at the series boundary.
      const value = f.inverse ? f.scaleMin + f.scaleMax - f.rating : f.rating;
      const slot = acc.get(f.key) ?? {
        ref: {
          key: f.key,
          labelKey: f.labelKey,
          categoryKey: f.categoryKey,
          icon: f.icon,
          inverse: f.inverse,
        },
        byDay: new Map<string, { sum: number; count: number }>(),
      };
      const cur = slot.byDay.get(entry.date) ?? { sum: 0, count: 0 };
      cur.sum += value;
      cur.count += 1;
      slot.byDay.set(entry.date, cur);
      acc.set(f.key, slot);
    }
  }
  const out = new Map<string, FactorDailySeries>();
  for (const [key, slot] of acc) {
    const byDay = new Map<string, number>();
    for (const [day, agg] of slot.byDay) byDay.set(day, agg.sum / agg.count);
    out.set(key, { ref: slot.ref, byDay });
  }
  return out;
}

interface FactorCrosstabCandidate {
  row: Omit<FactorMetricCrosstabRow, "qValue">;
}

/**
 * Compute the RATED-factor × metric crosstab. Pure over already-fetched
 * rows. Mirrors `computeTagMetricCrosstab` but splits each factor's
 * continuous daily score into low/high by its own median, then runs the
 * same Welch + FDR engine.
 */
export function computeFactorMetricCrosstab(args: {
  entries: MoodAggregateEntry[];
  measurements: CrossMetricMeasurement[];
  now: Date;
  windowDays?: number;
  userPriorityJson?: unknown;
}): FactorMetricCrosstabRow[] {
  const { entries, measurements, now } = args;
  const windowDays = args.windowDays ?? 365;
  const userPriorityJson = args.userPriorityJson ?? null;

  const factorSeries = buildFactorDailySeries(entries, now, windowDays);
  if (factorSeries.size === 0) return [];

  const candidates: FactorCrosstabCandidate[] = [];

  for (const [metricKey, cfg] of Object.entries(
    FACTOR_CROSSTAB_METRICS,
  ) as Array<
    [
      FactorCrosstabMetricKey,
      (typeof FACTOR_CROSSTAB_METRICS)[FactorCrosstabMetricKey],
    ]
  >) {
    const metricByDay = metricDayMap(measurements, cfg.type, userPriorityJson);
    if (metricByDay.size === 0) continue;

    for (const [factorKey, series] of factorSeries) {
      // The median split is over the factor's own rated days only, so a
      // sparse factor never borrows another's threshold.
      const ratedDays = [...series.byDay.values()];
      if (
        ratedDays.length <
        CROSSTAB_MIN_PRESENT_DAYS + CROSSTAB_MIN_ABSENT_DAYS
      ) {
        continue;
      }
      const split = median(ratedDays);

      const lowVals: number[] = [];
      const highVals: number[] = [];
      for (const [dayKey, score] of series.byDay) {
        const metricDayKey =
          cfg.mode === "nextDay" ? shiftDayKey(dayKey, 1) : dayKey;
        const metricValue = metricByDay.get(metricDayKey);
        if (metricValue == null || !Number.isFinite(metricValue)) continue;
        const display = toFactorDisplayUnit(metricValue, cfg.display);
        // Below the median is a "low" (worse, after the inverse flip) day;
        // at or above is "high". A perfectly bimodal factor with all days
        // exactly on the median falls entirely into "high" and fails the
        // low-side floor below — honest: no contrast, no row.
        if (score < split) lowVals.push(display);
        else highVals.push(display);
      }

      if (
        lowVals.length < CROSSTAB_MIN_PRESENT_DAYS ||
        highVals.length < CROSSTAB_MIN_ABSENT_DAYS
      ) {
        continue;
      }

      const welch = welchTTest(lowVals, highVals);
      const lowAvg = lowVals.reduce((s, v) => s + v, 0) / lowVals.length;
      const highAvg = highVals.reduce((s, v) => s + v, 0) / highVals.length;
      const delta = lowAvg - highAvg;
      if (delta === 0) continue;

      const pValue = welch.status === "ok" ? welch.pValue : 1;
      const minGroupDays = Math.min(lowVals.length, highVals.length);

      candidates.push({
        row: {
          factor: factorKey,
          labelKey: series.ref.labelKey,
          categoryKey: series.ref.categoryKey,
          icon: series.ref.icon,
          inverse: series.ref.inverse,
          metricKey,
          display: cfg.display,
          mode: cfg.mode,
          lowDays: lowVals.length,
          highDays: highVals.length,
          lowAvg: round(lowAvg, 2),
          highAvg: round(highAvg, 2),
          delta: round(delta, 2),
          pValue,
          confidence: influenceConfidence(pValue, minGroupDays),
        },
      });
    }
  }

  if (candidates.length === 0) return [];

  // One BH family across every factor × metric pair tested — the same
  // step-up the tag crosstab + discovery engine run.
  const qValues = fdrAdjust(candidates.map((c) => c.row.pValue));

  return candidates
    .map((c, i) => ({ ...c.row, qValue: Math.round(qValues[i] * 1000) / 1000 }))
    .filter((row) => row.pValue < 0.05 && row.qValue <= CROSSTAB_FDR_Q)
    .sort(
      (a, b) =>
        a.qValue - b.qValue ||
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.factor.localeCompare(b.factor),
    )
    .slice(0, CROSSTAB_MAX_ROWS);
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
  tz: string = DEFAULT_TIMEZONE,
): WeekdayRow[] {
  const sums = new Map<number, { sum: number; count: number }>();
  for (const bucket of daily) {
    const dayKey = dayOffsetToBerlinDayKey(now, bucket.dayOffset, tz);
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
    const { hour } = wallClockInTz(entry.moodLoggedAt, tz);
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

export type StabilityBand =
  | "verySteady"
  | "steady"
  | "variable"
  | "veryVariable";

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
export function computeMoodStability(
  daily: DailyPoint[],
): MoodStability | null {
  if (daily.length < STABILITY_MIN_DAYS) return null;

  const values = daily.map((bucket) => bucket.value);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  const normalised =
    Math.min(stdDev, STABILITY_SD_FULL_SCALE) / STABILITY_SD_FULL_SCALE;
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
  tz: string = DEFAULT_TIMEZONE,
): MoodMetricCorrelation {
  const pairs = pairDailyBuckets(moodDaily, metricDaily, now, tz);
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
   * v1.12.0 — per-tag × health-metric crosstab: for each structured tag,
   * a health metric's mean on tag-present vs tag-absent days (same-day or
   * D→D+1 lag), Welch-tested + FDR-corrected. Observational; the card
   * renders the standing "association, not cause" caption.
   */
  tagMetricCrosstab: TagMetricCrosstabRow[];
  /**
   * v1.14.0 — per-RATED-factor × health-metric crosstab: for each factor
   * the user scores per entry (work / sleep-quality / stress …), a vital's
   * mean on the days the factor was rated LOW vs HIGH (median split, same-day
   * or D→D+1), Welch-tested + FDR-corrected. The cross-domain bridge from a
   * subjective score to an objective vital. Observational; the card renders
   * the standing "association, not cause" caption.
   */
  factorCrosstab: FactorMetricCrosstabRow[];
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
  /**
   * The user's source-priority blob, threaded into the crosstab's
   * per-day canonical-source pick. `null` (the test default) resolves to
   * the default ladders.
   */
  userPriorityJson?: unknown;
  /**
   * v1.2.5 (M-TZ3) — the user's IANA timezone. Threaded into every day
   * bucketing pass so a near-midnight reading lands on the user's own
   * calendar day. Defaults to Berlin for legacy / test callers.
   */
  tz?: string;
}): MoodAggregates {
  const { entries, measurements, now } = args;
  const userPriorityJson = args.userPriorityJson ?? null;
  const tz = args.tz ?? DEFAULT_TIMEZONE;

  const moodPoints = entries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodPoints, { now, tz });
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
      { now, tz },
    ).daily;

  const windowDays = selectHeatmapWindow(totalSpanDays);

  const weekday = computeWeekdayAverages(moodDaily, now, tz);
  const timeOfDay = computeTimeOfDayAverages(entries);
  const stability = computeMoodStability(moodDaily);
  const tags = computeTagSummary(entries, now);
  const structuredTags = computeStructuredTagSummary(entries, now);
  const tagInfluence = computeTagInfluence(entries, now);
  const inTargetPct = computeInTargetPct(moodDaily);

  const correlations = Object.fromEntries(
    Object.entries(CORRELATION_METRICS).map(([key, type]) => [
      key,
      computeMoodMetricCorrelation(moodDaily, metricDaily(type), now, tz),
    ]),
  ) as MoodAggregates["correlations"];

  const betterDays = computeBetterDays(tagInfluence, correlations);
  const tagMetricCrosstab = computeTagMetricCrosstab({
    entries,
    measurements,
    now,
    userPriorityJson,
  });
  const factorCrosstab = computeFactorMetricCrosstab({
    entries,
    measurements,
    now,
    userPriorityJson,
  });

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
    tagMetricCrosstab,
    factorCrosstab,
    narratives: computeMoodNarratives({
      daily: moodDaily,
      weekday,
      timeOfDay,
      tags,
      structuredTags,
      inTargetPct,
      loggedDayKeys,
      now,
      tz,
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
        // v1.14.0 — also pull the per-link `rating` + the factor's
        // kind/scale/inverse so RATED factors feed the factor crosstab.
        tagLinks: {
          select: {
            rating: true,
            moodTag: {
              select: {
                key: true,
                labelKey: true,
                // v1.16.11 — owner + ciphertext so a custom tag's decrypted
                // label can ride beside its labelKey (which just mirrors the
                // raw `custom:<uuid>` key). Decrypted once per tag below.
                userId: true,
                labelEncrypted: true,
                icon: true,
                kind: true,
                scaleMin: true,
                scaleMax: true,
                inverse: true,
                category: { select: { key: true } },
              },
            },
          },
        },
      },
    })
    .then((rows) => {
      // Memoised per-tag decrypt — once per distinct custom tag, never per
      // entry link, so a 2000-row read costs at most one decrypt per tag.
      const resolveLabel = createCustomLabelResolver();
      return rows.reverse().map((row) => ({
        date: row.date,
        score: row.score,
        tags: parseTags(row.tags),
        moodLoggedAt: row.moodLoggedAt,
        tz: row.tz,
        // BINARY links carry the structured-tag breakdown; RATED links
        // (a non-null `rating`) carry the factor score. One join, two axes.
        structuredTags: row.tagLinks
          .filter((link) => link.moodTag.kind !== "RATED")
          .map((link) => ({
            key: link.moodTag.key,
            categoryKey: link.moodTag.category.key,
            labelKey: link.moodTag.labelKey,
            label: resolveLabel(link.moodTag),
            icon: link.moodTag.icon,
          })),
        ratedFactors: row.tagLinks
          .filter(
            (link): link is typeof link & { rating: number } =>
              link.moodTag.kind === "RATED" && link.rating != null,
          )
          .map((link) => ({
            key: link.moodTag.key,
            categoryKey: link.moodTag.category.key,
            labelKey: link.moodTag.labelKey,
            icon: link.moodTag.icon,
            rating: link.rating,
            scaleMin: link.moodTag.scaleMin,
            scaleMax: link.moodTag.scaleMax,
            inverse: link.moodTag.inverse,
          })),
      }));
    });

  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        deletedAt: null,
        measuredAt: { gte: windowCutoff },
        // v1.8.5 — single-sourced from CORRELATION_METRICS so the fetched
        // channels and the computed correlations never drift apart.
        // v1.12.0 — union the crosstab metric channels so the tag × metric
        // board has its measurements without a second query.
        type: {
          in: Array.from(
            new Set<MeasurementType>([
              ...(Object.values(CORRELATION_METRICS) as MeasurementType[]),
              ...CROSSTAB_METRIC_TYPES,
              // v1.14.0 — union the factor-crosstab vital channels (RHR /
              // HRV / steps / sleep / weight / BP-sys) so the factor board
              // has its measurements without a second query.
              ...FACTOR_CROSSTAB_METRIC_TYPES,
            ]),
          ),
        },
      },
      orderBy: { measuredAt: "desc" },
      // v1.12.1 — scope the cap to the worst-case row count over the
      // 365-day window instead of the old flat 5,000. The crosstab +
      // correlation channels are per-day aggregates, but the read is raw
      // because the DAY rollup buckets on UTC midnight while the crosstab
      // / correlations key on the user's Berlin calendar day — feeding a
      // UTC-bucketed metric series against a Berlin-bucketed mood series
      // would skew the day pairing by up to a few hours at the boundary.
      // So we stay on raw rows but lift the cap above the realistic worst
      // case: SLEEP_DURATION (~6 stage rows/night) and PULSE / HRV ingest
      // the most rows/day, and a user syncing several sources multiplies
      // that — a flat 5,000 silently dropped the oldest months (the order
      // is `measuredAt desc`). The cap is the floor that keeps a full
      // data-rich year intact; if it is ever hit we annotate `truncated`
      // so the drop is observable rather than silently recency-biased.
      take: MOOD_CROSS_METRIC_ROW_CAP,
      select: {
        type: true,
        value: true,
        measuredAt: true,
        // v1.12.1 — source + deviceType drive the crosstab's canonical
        // per-day pick so a cumulative metric reported by two sources on
        // the same day (Fitbit + Apple steps, Fitbit + WHOOP sleep) is
        // summed once, not double-counted.
        source: true,
        deviceType: true,
      },
    })
    .then((rows) => rows.reverse());

  if (measurements.length >= MOOD_CROSS_METRIC_ROW_CAP) {
    // The read hit the cap — the oldest rows in the 365-day window were
    // dropped (order is `measuredAt desc`). Surface it on the wide event
    // so a silently-truncated, recency-biased crosstab/correlation is at
    // least observable instead of looking like clean data.
    annotate({
      action: { name: "mood.insights.cross_metric.truncated" },
      meta: { rows: measurements.length, cap: MOOD_CROSS_METRIC_ROW_CAP },
    });
  }

  const [userPriorityJson, tz] = await Promise.all([
    loadUserSourcePriority(userId),
    resolveUserTimezone(userId),
  ]);

  return computeMoodAggregates({
    entries,
    measurements,
    now,
    userPriorityJson,
    tz,
  });
}
