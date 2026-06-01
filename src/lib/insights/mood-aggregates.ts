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
import {
  computeMoodNarratives,
  type MoodNarrative,
} from "@/lib/insights/mood-narratives";

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
  tags: TagSummaryRow[];
  /** v1.8.5 — structured-tag breakdown from the taxonomy join. */
  structuredTags: StructuredTagRow[];
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
  const tags = computeTagSummary(entries, now);
  const structuredTags = computeStructuredTagSummary(entries, now);
  const inTargetPct = computeInTargetPct(moodDaily);

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
    tags,
    structuredTags,
    narratives: computeMoodNarratives({
      daily: moodDaily,
      weekday,
      tags,
      structuredTags,
      inTargetPct,
      loggedDayKeys,
      now,
    }),
    correlations: Object.fromEntries(
      Object.entries(CORRELATION_METRICS).map(([key, type]) => [
        key,
        computeMoodMetricCorrelation(moodDaily, metricDaily(type), now),
      ]),
    ) as MoodAggregates["correlations"],
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
