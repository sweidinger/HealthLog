import { prisma } from "@/lib/db";
import { getMoodSystemPrompt, getMoodUserPrompt } from "@/lib/ai/prompts/mood";
import { getNoKeyMoodStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { pearsonCorrelation } from "@/lib/analytics/correlations";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  type TagInfluenceRow,
  MOOD_GREEN_MAX,
  MOOD_GREEN_MIN,
  MOOD_ORANGE_MAX,
  MOOD_ORANGE_MIN,
  computeBetterDays,
  computeInTargetPct,
  computeMoodMetricCorrelation,
  computeMoodStability,
  computeStructuredTagSummary,
  computeTagInfluence,
  computeTagSummary,
  computeTimeOfDayAverages,
  computeWeekdayAverages,
  pairDailyBuckets,
} from "@/lib/insights/mood-aggregates";
import { computeMoodNarratives } from "@/lib/insights/mood-narratives";
import {
  buildGradedSeriesFromPoints,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import {
  type SupportedLocale,
  normalizeLocale,
  normalizeSummaryText,
  parseSummaryFromContent,
  persistStatusInsight,
  round,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey } from "@/lib/tz/resolver";

/**
 * Drop the ranking-only `pooledSd` before a tag-influence row enters the
 * snapshot payload — it exists solely to standardize the better-days sort
 * and has no place in the model prompt or the UI.
 */
function stripRankingOnly(row: TagInfluenceRow): Omit<TagInfluenceRow, "pooledSd"> {
  const { pooledSd: _pooledSd, ...rest } = row;
  void _pooledSd;
  return rest;
}

export async function generateMoodStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /** v1.9.0 — last-good text served while a refresh is in flight; keep polling. */
  revalidating?: boolean;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = statusCacheAction("mood", locale);
  const todayKey = toBerlinDayKey(new Date());

  const cached = await readFreshStatusText({
    userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      hasProvider: true,
      text: cached.text,
      cached: true,
      updatedAt: cached.updatedAt,
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "mood",
      locale,
    });
    if (outcome.kind === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyMoodStatusText(locale),
        cached: true,
        updatedAt: null,
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good assessment
    // (if any) instantly while the worker re-warms; only fall to the empty
    // preparing skeleton when none was ever produced.
    return {
      hasProvider: true,
      text: outcome.lastGood?.text ?? null,
      cached: outcome.lastGood !== null,
      updatedAt: outcome.lastGood?.updatedAt ?? null,
      preparing: outcome.lastGood === null,
      revalidating: outcome.revalidating,
    };
  }

  // v1.4.28 FB-D2 — cap at 90 entries (~3 months) for the mood
  // surface. The downstream `applyPayloadBudget` slims further.
  // Order desc + reverse so the per-row consumers downstream (which
  // expect oldest-first) see the same shape.
  const entries = await prisma.moodEntry
    .findMany({
      where: {
        userId,
      },
      orderBy: { date: "desc" },
      take: 90,
      select: {
        date: true,
        score: true,
        tags: true,
        moodLoggedAt: true,
        // v1.9.0 — per-row tz anchors the part-of-day bucketing so the
        // snapshot's time-of-day signal matches the visible mood page.
        tz: true,
        // v1.8.6 — pull the structured-tag links so the snapshot feeds
        // `computeMoodNarratives` the same structured-tag pool the visible
        // mood page does (shown == sent for the tag→mood takeaways).
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
        tags: row.tags,
        moodLoggedAt: row.moodLoggedAt,
        tz: row.tz,
        structuredTags: (row.tagLinks ?? []).map((link) => ({
          key: link.moodTag.key,
          categoryKey: link.moodTag.category.key,
          labelKey: link.moodTag.labelKey,
          icon: link.moodTag.icon,
        })),
      })),
    );

  const now = new Date();

  const moodPoints = entries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  // `applyPayloadBudget` daily buckets drive the in-target %, latest,
  // and correlations; the compact graded series reaches the prompt.
  const moodSeries = applyPayloadBudget(moodPoints, { now });
  const moodGraded = buildGradedSeriesFromPoints(moodPoints, now);
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );

  const greenMin = MOOD_GREEN_MIN;
  const greenMax = MOOD_GREEN_MAX;
  const orangeMin = MOOD_ORANGE_MIN;
  const orangeMax = MOOD_ORANGE_MAX;

  // "Last 30 daily points" = the newest 30 daily buckets (offsets 0..29).
  const inTargetPctLast30DailyPoints = computeInTargetPct(moodSeries.daily);

  // daily[0] = newest bucket (lowest dayOffset).
  const latestMood = moodSeries.daily[0] ?? null;
  const previousMood = moodSeries.daily[1] ?? null;

  const oldestEntry = entries.length > 0 ? entries[0].moodLoggedAt : null;
  const newestEntry =
    entries.length > 0 ? entries[entries.length - 1].moodLoggedAt : null;
  const totalSpanDays =
    oldestEntry && newestEntry
      ? Math.round(
          (newestEntry.getTime() - oldestEntry.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestEntryDaysAgo = newestEntry
    ? Math.round((Date.now() - newestEntry.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  // Fetch cross-metric context for enrichment. v1.4.28 FB-D2 — cap at
  // 1095 = 365 d × 3 channels so power users do not pull unbounded
  // rows. Order desc + reverse so the downstream filters see oldest-
  // first as before.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: { in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "PULSE"] },
      },
      orderBy: { measuredAt: "desc" },
      take: 1095,
      select: { type: true, value: true, measuredAt: true },
    })
    .then((rows) => rows.reverse());

  const weightSeries = applyPayloadBudget(
    measurements
      .filter((m) => m.type === "WEIGHT")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
    { now },
  );

  const sysSeries = applyPayloadBudget(
    measurements
      .filter((m) => m.type === "BLOOD_PRESSURE_SYS")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
    { now },
  );

  const pulseSeries = applyPayloadBudget(
    measurements
      .filter((m) => m.type === "PULSE")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
    { now },
  );

  // Correlations between mood and other metrics — pair on dayOffset so
  // the bucketed daily window aligns across metrics.
  const moodVsWeightPairs = pairDailyBuckets(
    moodSeries.daily,
    weightSeries.daily,
    now,
  );
  const moodVsWeightCorrelation = pearsonCorrelation(moodVsWeightPairs);

  const moodVsSysPairs = pairDailyBuckets(
    moodSeries.daily,
    sysSeries.daily,
    now,
  );
  const moodVsSysCorrelation = pearsonCorrelation(moodVsSysPairs);

  const moodVsPulsePairs = pairDailyBuckets(
    moodSeries.daily,
    pulseSeries.daily,
    now,
  );
  const moodVsPulseCorrelation = pearsonCorrelation(moodVsPulsePairs);

  // Extract tag frequencies from recent entries — keep the v1.4.5
  // ~90-day window so the model still gets a recency-weighted view of
  // tag patterns. Shared with the `/api/mood/insights` tag breakdown
  // via `computeTagSummary` so the prose and the chart never drift.
  const tagSummary = computeTagSummary(entries, now);
  const structuredTagSummary = computeStructuredTagSummary(entries, now);

  // v1.11.5 (F1/F2) — tag "Influence on Mood" + the unified "better days"
  // board, computed from the same aggregates the visible mood page shows so
  // the model's prose never contradicts the on-screen relations. The
  // snapshot fetches only weight / systolic / pulse cross-metrics, so the
  // board's metric factors are limited to those three channels (sleep /
  // steps are absent here by design — the model sees only what it fetched).
  const tagInfluence = computeTagInfluence(entries, now);
  const emptyCorrelation = computeMoodMetricCorrelation([], [], now);
  const betterDays = computeBetterDays(tagInfluence, {
    sleep: emptyCorrelation,
    steps: emptyCorrelation,
    pulse: computeMoodMetricCorrelation(moodSeries.daily, pulseSeries.daily, now),
    weight: computeMoodMetricCorrelation(
      moodSeries.daily,
      weightSeries.daily,
      now,
    ),
    bloodPressureSystolic: computeMoodMetricCorrelation(
      moodSeries.daily,
      sysSeries.daily,
      now,
    ),
  });

  // v1.8.6 — the same threshold-gated narrative feed the user sees on
  // the mood page, computed from the same aggregates so the prose the
  // model writes never contradicts the takeaways on screen (shown ==
  // sent). Both the flat free-text tags and the structured taxonomy tags
  // feed the tag→mood pool, matching the visible feed exactly.
  // v1.9.0 — tz-aware part-of-day pattern + day-to-day stability. Computed
  // here so the snapshot carries the same signals the visible mood page
  // surfaces (shown == sent), and the narrative feed can cite the daypart.
  const timeOfDay = computeTimeOfDayAverages(entries);
  const stability = computeMoodStability(moodSeries.daily);

  const narratives = computeMoodNarratives({
    daily: moodSeries.daily,
    weekday: computeWeekdayAverages(moodSeries.daily, now),
    timeOfDay,
    tags: tagSummary,
    structuredTags: structuredTagSummary,
    inTargetPct: inTargetPctLast30DailyPoints,
    loggedDayKeys: Array.from(new Set(entries.map((entry) => entry.date))),
    now,
  });

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "mood",
    dataCoverage: {
      totalEntries: entries.length,
      totalSpanDays,
      newestEntryDaysAgo,
    },
    mood: {
      summary: moodSummary,
      series: moodGraded,
      latestDayFocus: latestMood
        ? {
            dayOffset: latestMood.dayOffset,
            value: latestMood.value,
            deltaToPreviousDailyPoint:
              previousMood == null
                ? null
                : round(latestMood.value - previousMood.value, 2),
          }
        : null,
      target: {
        greenMin,
        greenMax,
        orangeMin,
        orangeMax,
        inTargetPctLast30DailyPoints,
      },
      tags: tagSummary.length > 0 ? tagSummary : null,
      // v1.11.5 (F1) — with-vs-without tag influence (only the populated
      // axes are emitted so the prompt stays compact).
      tagInfluence:
        tagInfluence.flat.length > 0 || tagInfluence.structured.length > 0
          ? {
              flat:
                tagInfluence.flat.length > 0
                  ? tagInfluence.flat.map(stripRankingOnly)
                  : null,
              structured:
                tagInfluence.structured.length > 0
                  ? tagInfluence.structured.map(stripRankingOnly)
                  : null,
            }
          : null,
      // v1.11.5 (F2) — the ranked "better days" board the user sees, so the
      // model's relations prose matches the on-screen list (shown == sent).
      betterDays: betterDays.length > 0 ? betterDays : null,
      narratives: narratives.length > 0 ? narratives : null,
      // v1.9.0 — only emit the daypart pattern when it cleared its
      // spread/sample floors, so the model never reasons over a once-a-day
      // logger's single-bucket artefact.
      timeOfDay: timeOfDay.reliable
        ? {
            buckets: timeOfDay.buckets,
            best: timeOfDay.best,
            worst: timeOfDay.worst,
          }
        : null,
      stability,
    },
    crossMetricContext:
      weightSeries.daily.length >= 3 ||
      sysSeries.daily.length >= 3 ||
      pulseSeries.daily.length >= 3
        ? {
            weight:
              weightSeries.daily.length >= 3
                ? {
                    summary: summarizeSeries(
                      weightSeries.daily.map((bucket) => ({
                        value: bucket.value,
                      })),
                    ),
                    correlation: moodVsWeightCorrelation,
                  }
                : null,
            bloodPressureSystolic:
              sysSeries.daily.length >= 3
                ? {
                    summary: summarizeSeries(
                      sysSeries.daily.map((bucket) => ({
                        value: bucket.value,
                      })),
                    ),
                    correlation: moodVsSysCorrelation,
                  }
                : null,
            pulse:
              pulseSeries.daily.length >= 3
                ? {
                    summary: summarizeSeries(
                      pulseSeries.daily.map((bucket) => ({
                        value: bucket.value,
                      })),
                    ),
                    correlation: moodVsPulseCorrelation,
                  }
                : null,
          }
        : null,
  };

  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
  });

  const previousContext = await getPreviousInsightContext(
    userId,
    "mood-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  const outcome = await runStatusCompletion({
    userId,
    cacheAction,
    systemPrompt: getMoodSystemPrompt(locale),
    userPrompt: getMoodUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
    ),
    temperature: 0.3,
    maxTokens: 1000,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      text: getNoKeyMoodStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    return returnTimeoutFallback({
      cacheAction,
      reason: outcome.kind,
      userId,
      todayKey,
      stubText: getNoKeyMoodStatusText(locale),
    });
  }

  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!summary) {
    throw new Error("Mood-status summary was empty after normalization");
  }

  const updatedAt = await persistStatusInsight({
    userId,
    cacheAction,
    todayKey,
    locale,
    text: summary,
    providerType: outcome.providerType,
    model: outcome.model,
    tokensUsed: outcome.tokensUsed,
  });

  return {
    hasProvider: true,
    text: summary,
    cached: false,
    updatedAt,
  };
}

export function resolveMoodStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
