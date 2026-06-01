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
  MOOD_GREEN_MAX,
  MOOD_GREEN_MIN,
  MOOD_ORANGE_MAX,
  MOOD_ORANGE_MIN,
  computeInTargetPct,
  computeTagSummary,
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
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey } from "@/lib/tz/resolver";

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
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = `insights.mood-status.${locale}`;
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
    if (outcome === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyMoodStatusText(locale),
        cached: true,
        updatedAt: null,
      };
    }
    return {
      hasProvider: true,
      text: null,
      cached: false,
      updatedAt: null,
      preparing: true,
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
      },
    })
    .then((rows) => rows.reverse());

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

  // v1.8.6 — the same threshold-gated narrative feed the user sees on
  // the mood page, computed from the same aggregates so the prose the
  // model writes never contradicts the takeaways on screen (shown ==
  // sent). Structured tags are not loaded on this lean snapshot path,
  // so the tag deltas ride the flat-tag summary only.
  const narratives = computeMoodNarratives({
    daily: moodSeries.daily,
    weekday: computeWeekdayAverages(moodSeries.daily, now),
    tags: tagSummary,
    structuredTags: [],
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
      narratives: narratives.length > 0 ? narratives : null,
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
