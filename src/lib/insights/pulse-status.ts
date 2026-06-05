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
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey } from "@/lib/tz/resolver";

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
    if (outcome.kind === "no-provider") {
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
    },
  });

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

  // "Last 30 daily points" = the newest 30 daily buckets (offsets 0..29).
  const recentPulseDaily = pulseSeries.daily.filter(
    (bucket) => bucket.dayOffset < 30,
  );
  const inTargetPctLast30DailyPoints =
    recentPulseDaily.length === 0
      ? null
      : round(
          (recentPulseDaily.filter(
            (entry) =>
              entry.value >= pulseTarget.greenMin &&
              entry.value <= pulseTarget.greenMax,
          ).length /
            recentPulseDaily.length) *
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
