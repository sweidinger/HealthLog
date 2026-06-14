import { prisma } from "@/lib/db";
import {
  getPulseSystemPrompt,
  getPulseUserPrompt,
} from "@/lib/ai/prompts/pulse";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  computeSteadyRun,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { getRelevantCorrelationsForMetric } from "@/lib/insights/metric-correlation-context";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import { resolveRestingPulseSeries } from "@/lib/analytics/resting-pulse";
import { getNoKeyPulseStatusText } from "@/lib/insights/no-key-fallbacks";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
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
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey, userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";

export async function generatePulseStatusForUser(
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
  const cacheAction = statusCacheAction("pulse", locale);
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
      metric: "pulse",
      locale,
    });
    // v1.16.13 — `consent-missing` serves the same no-key fallback (see
    // bmi-status); no enqueue happens for it.
    if (outcome.kind === "no-provider" || outcome.kind === "consent-missing") {
      return {
        hasProvider: false,
        text: getNoKeyPulseStatusText(locale),
        cached: true,
        updatedAt: null,
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good assessment (if
    // any) instantly while the worker re-warms the cache; only fall to the
    // empty preparing skeleton when none was ever produced.
    return {
      hasProvider: true,
      text: outcome.lastGood?.text ?? null,
      cached: outcome.lastGood !== null,
      updatedAt: outcome.lastGood?.updatedAt ?? null,
      preparing: outcome.lastGood === null,
      revalidating: outcome.revalidating,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
      gender: true,
      timezone: true,
    },
  });

  // v1.15.12 (audit LOW-2) — bucket the resting-pulse proxy on the user's
  // own day boundary so this surface aligns with the targets route, which
  // passes `userDayKey(d, userTz)`. Without it the proxy bucketed on
  // Berlin-day here and on the user's TZ there, drifting the resting
  // estimate for non-Berlin users.
  const userTz = user?.timezone ?? DEFAULT_TIMEZONE;

  // v1.4.28 FB-D2 — cap the snapshot input. The downstream
  // `applyPayloadBudget` trims further but the unbounded findMany was
  // pulling tens of thousands of rows for Apple-Health-rich accounts
  // before the budget call even started.
  const measurements = await prisma.measurement.findMany({
    where: {
      userId,
      type: "PULSE",
      deletedAt: null,
    },
    orderBy: { measuredAt: "desc" },
    take: 365,
    select: {
      value: true,
      measuredAt: true,
    },
  }).then((rows) => rows.reverse());

  // v1.15.12 A2 — the RESTING band is judged against the RESTING series,
  // not the raw PULSE stream (Apple fills PULSE with workout HR). Pull
  // RESTING_HEART_RATE rows; the resolver falls back to a low-percentile
  // PULSE proxy when the user has none.
  const restingMeasurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: "RESTING_HEART_RATE",
        deletedAt: null,
      },
      orderBy: { measuredAt: "desc" },
      take: 365,
      select: { value: true, measuredAt: true },
    })
    .then((rows) => rows.reverse());

  const now = new Date();

  const pulsePoints = measurements.map((measurement) => ({
    measuredAt: measurement.measuredAt,
    value: measurement.value,
  }));
  // `applyPayloadBudget` daily buckets still drive the derived stats
  // below (latest, in-target %, delta). They are NOT embedded in the
  // prompt — the compact graded series replaces the full daily array.
  const pulseSeries = applyPayloadBudget(pulsePoints, { now });
  // Primary metric: recent / weekly fold from the bounded raw read, the
  // monthly / yearly tail comes from the MONTH / YEAR rollup tier (with
  // a full-history in-memory fallback on a cold-tier coverage miss).
  const pulseGraded = await buildGradedSeriesWithRollups(userId, "PULSE", now);
  const pulseSummary = summarizeSeries(
    pulseSeries.daily.map((bucket) => ({ value: bucket.value })),
  );

  // Fetch mood context (optional — for enrichment only). Cap at 90
  // entries (~3 months); the bucket-series budget then summarises
  // further. v1.4.28 FB-D2 — prevent unbounded reads for power users.
  const moodEntries = await prisma.moodEntry
    .findMany({
      where: { userId },
      orderBy: { moodLoggedAt: "desc" },
      take: 90,
      select: { date: true, score: true, moodLoggedAt: true },
    })
    .then((rows) => rows.reverse());

  const moodPoints = moodEntries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodPoints, { now });
  const moodGraded = buildGradedSeriesFromPoints(moodPoints, now);
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    (user?.gender as "MALE" | "FEMALE" | null | undefined) ?? null,
  );

  // v1.15.12 A2 — resting-target in-target % over the RESTING series
  // (preferring RESTING_HEART_RATE, else the low-percentile PULSE proxy),
  // NOT the raw PULSE daily buckets which mix in workout HR. Scoring the
  // raw stream against a resting band counted a workout day as "over
  // target" and tanked the %.
  const restingResolved = resolveRestingPulseSeries({
    restingSamples: restingMeasurements.map((m) => ({
      measuredAt: m.measuredAt,
      value: m.value,
    })),
    pulseSamples: measurements.map((m) => ({
      measuredAt: m.measuredAt,
      value: m.value,
    })),
    dayKeyOf: (d: Date) => userDayKey(d, userTz),
  });
  const thirtyDaysAgoMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const recentResting = restingResolved.series.filter(
    (p) => p.measuredAt.getTime() >= thirtyDaysAgoMs,
  );
  const inTargetPctLast30DailyPoints =
    recentResting.length === 0
      ? null
      : round(
          (recentResting.filter(
            (entry) =>
              entry.value >= pulseTarget.greenMin &&
              entry.value <= pulseTarget.greenMax,
          ).length /
            recentResting.length) *
            100,
          1,
        );

  // Daily buckets are sorted oldest-first by dayOffset (lower = newer).
  const latestPulse = pulseSeries.daily[0] ?? null;
  const previousPulse = pulseSeries.daily[1] ?? null;

  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestMeasurementDaysAgo = newestMeasurement
    ? Math.round(
        (Date.now() - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
      )
    : null;

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "pulse",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    pulse: {
      summary: pulseSummary,
      series: pulseGraded,
      latestDayFocus: latestPulse
        ? {
            dayOffset: latestPulse.dayOffset,
            value: latestPulse.value,
            deltaToPreviousDailyPoint:
              previousPulse == null
                ? null
                : round(latestPulse.value - previousPulse.value, 2),
          }
        : null,
      target: {
        greenMin: pulseTarget.greenMin,
        greenMax: pulseTarget.greenMax,
        orangeMin: pulseTarget.orangeMin,
        orangeMax: pulseTarget.orangeMax,
        inTargetPctLast30DailyPoints,
      },
    },
    moodContext:
      moodSeries.daily.length >= 3
        ? {
            points: moodSeries.daily.length,
            mean: moodMean,
            latest: moodSeries.daily[0]?.value ?? null,
            series: moodGraded,
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

  // Content-hash gate (v1.16.8): when the snapshot is unchanged since the
  // last real assessment, refresh the cache timestamp and skip the LLM.
  const snapshotHash = hashInsightSnapshot(snapshot);
  const unchanged = await refreshUnchangedStatusInsight({
    userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged) {
    return {
      hasProvider: true,
      text: unchanged.text,
      cached: true,
      updatedAt: unchanged.updatedAt,
    };
  }

  const previousContext = await getPreviousInsightContext(
    userId,
    "pulse-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.7 — diversity / anti-repetition block (see blood-pressure-status).
  const varietyLead = pickVarietyLead(userId, "pulse", todayKey);
  const steadyRun = computeSteadyRun(pulseGraded.weekly, pulseGraded.monthly);
  const relations = await getRelevantCorrelationsForMetric(userId, "PULSE");
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: pulseSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
      },
      repeatCount: steadyRun,
      relations,
    },
    locale,
  );

  const outcome = await runStatusCompletion({
    userId,
    cacheAction,
    consentSurface: "insights",
    systemPrompt: getPulseSystemPrompt(locale),
    userPrompt: getPulseUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
    ),
    // v1.12.7 — match the archetype cards' 0.45.
    temperature: 0.45,
    maxTokens: 1000,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      text: getNoKeyPulseStatusText(locale),
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
      stubText: getNoKeyPulseStatusText(locale),
    });
  }

  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!summary) {
    throw new Error("Pulse-status summary was empty after normalization");
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
    snapshotHash,
  });

  return {
    hasProvider: true,
    text: summary,
    cached: false,
    updatedAt,
  };
}

export function resolvePulseStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
