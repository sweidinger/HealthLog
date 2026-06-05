/**
 * v1.8.7.1 — generic per-HealthKit-metric assessment generator.
 *
 * The seven specialised generators (`pulse-status.ts`, …) each hand-roll
 * a metric-specific snapshot + prompt. This one generator covers every
 * registered HealthKit metric (`metric-status-registry.ts`) through the
 * archetype prompt templates (`prompts/metric-archetypes.ts`), reusing
 * the exact same machinery the specialised cards use:
 *   - the graded-series snapshot builder (`buildGradedSeriesWithRollups`),
 *   - the shared provider runner (`runStatusCompletion`),
 *   - the stale-while-revalidate cache (`readFreshStatusText` /
 *     `resolveReadOnlyStatusMiss`),
 *   - the standard cache-row persist (`persistStatusInsight`),
 *   - the previous-context comparison block (`getPreviousInsightContext`).
 *
 * The return shape is byte-identical to the specialised generators so
 * `InsightStatusCard` consumes it unchanged.
 *
 * Empty-data guard (design §3): when the metric has no readings the
 * generator returns an `insufficient` marker WITHOUT touching the
 * provider chain — no LLM call, no cache write. The route maps that onto
 * the card's insufficient-data state.
 */
import { prisma } from "@/lib/db";
import {
  getMetricArchetypeSystemPrompt,
  getMetricArchetypeUserPrompt,
} from "@/lib/ai/prompts/metric-archetypes";
import {
  getMetricStatusMeta,
  metricStatusScope,
  type MetricStatusMeta,
  type MetricStatusMetricId,
} from "@/lib/insights/metric-status-registry";
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
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { lookupNormalRange } from "@/lib/insights/derived/norms";
import { getNoKeyGeneralStatusText } from "@/lib/insights/no-key-fallbacks";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesWithRollups,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import {
  type SupportedLocale,
  normalizeLocale,
  normalizeSummaryText,
  parseSummaryFromContent,
  persistStatusInsight,
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

export interface MetricStatusResult {
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  /**
   * v1.9.0 — true when last-good text is served while a fresh generation is
   * in flight. The card keeps polling (bounded) so the open page upgrades to
   * the warmed assessment without a remount.
   */
  revalidating?: boolean;
  /**
   * v1.8.7.1 — true when the metric has no data at all. The route maps
   * this onto the card's insufficient-data state; no LLM was called.
   */
  insufficient?: boolean;
}

/** Count this metric's live (non-deleted) readings — the empty-data gate. */
async function countMetricReadings(
  userId: string,
  meta: MetricStatusMeta,
): Promise<number> {
  return prisma.measurement.count({
    where: { userId, type: meta.measurementType, deletedAt: null },
  });
}

/**
 * Generate (or read from cache) the generic assessment for one metric.
 * Mirrors the specialised generators' contract:
 *   - cache hit (today, non-stub) → serve it,
 *   - `readOnly` miss → enqueue out-of-band + serve last-good
 *     (stale-while-revalidate),
 *   - empty data → `insufficient`, no LLM call,
 *   - otherwise → build snapshot, run completion, persist.
 */
export async function generateMetricStatus(args: {
  metric: MetricStatusMetricId;
  userId: string;
  locale?: string | null;
  force?: boolean;
  /** Read-only navigation path — never blocks on the provider. */
  readOnly?: boolean;
}): Promise<MetricStatusResult> {
  const meta = getMetricStatusMeta(args.metric);
  if (!meta) {
    // Defensive — the route Zod-validates against the registry, so an
    // unknown id never reaches here. Treat as insufficient rather than
    // throwing so a stale caller degrades gracefully.
    return {
      hasProvider: false,
      text: null,
      cached: false,
      updatedAt: null,
      insufficient: true,
    };
  }

  const locale = normalizeLocale(args.locale);
  const force = args.force === true;
  const readOnly = args.readOnly === true;
  const scope = metricStatusScope(meta.id);
  const cacheAction = statusCacheAction(scope, locale);
  const todayKey = toBerlinDayKey(new Date());

  const cached = await readFreshStatusText({
    userId: args.userId,
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

  // Empty-data guard — no readings means no assessment to generate. Done
  // BEFORE the read-only enqueue so an empty metric never queues an LLM
  // job nor blocks on the provider. The nightly warm pass applies the same
  // gate so the cron never burns a call on an empty metric either.
  const readingCount = await countMetricReadings(args.userId, meta);
  if (readingCount === 0) {
    annotate({
      action: { name: "insights.metric-status.insufficient" },
      meta: { metric: meta.id },
    });
    return {
      hasProvider: true,
      text: null,
      cached: false,
      updatedAt: null,
      insufficient: true,
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId: args.userId,
      metric: scope,
      locale,
    });
    if (outcome.kind === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyGeneralStatusText(locale),
        cached: true,
        updatedAt: null,
      };
    }
    // Stale-while-revalidate: serve the last good assessment (if any)
    // instantly while the worker re-warms the cache; only fall to the
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
    where: { id: args.userId },
    select: { dateOfBirth: true, gender: true },
  });

  const now = new Date();

  // Bounded raw read for the derived recent stats; the monthly/yearly
  // tail comes from the rollup tier (full-history fallback on a miss),
  // exactly as the specialised cards do.
  const measurements = await prisma.measurement
    .findMany({
      where: { userId: args.userId, type: meta.measurementType, deletedAt: null },
      orderBy: { measuredAt: "desc" },
      take: 365,
      select: { value: true, measuredAt: true },
    })
    .then((rows) => rows.reverse());

  const points = measurements.map((m) => ({
    measuredAt: m.measuredAt,
    value: m.value,
  }));
  const series = applyPayloadBudget(points, { now });
  const graded = await buildGradedSeriesWithRollups(
    args.userId,
    meta.measurementType,
    now,
  );
  const summary = summarizeSeries(
    series.daily.map((bucket) => ({ value: bucket.value })),
  );

  const latest = series.daily[0] ?? null;

  const oldest = measurements.length > 0 ? measurements[0].measuredAt : null;
  const newest =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldest && newest
      ? Math.round(
          (newest.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestDaysAgo = newest
    ? Math.round((Date.now() - newest.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const ageYears = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const sex =
    user?.gender === "MALE" || user?.gender === "FEMALE"
      ? user.gender
      : null;

  // v1.10.0 F1 — sharpen the coarse registry `normalRange` with the
  // age/sex reference-range enabler when one is available for this
  // metric + profile; otherwise keep the existing flat anchor (strictly
  // additive, never a regression). Age + sex only — no ancestry/region.
  const sharpenedRange = lookupNormalRange(meta.id, ageYears, sex);
  const normalRange = sharpenedRange ?? meta.normalRange;

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: meta.id,
    metric: {
      id: meta.id,
      displayName: meta.displayName,
      unit: meta.unit,
      direction: meta.direction,
      ...(normalRange ? { normalRange } : {}),
      ...(sharpenedRange ? { normalRangeSource: "age-sex-adjusted" } : {}),
    },
    // Profile context for placement only when stored — the medical note
    // limits population ranges to age + sex (NO ancestry/region). Omitted
    // when the profile leaves them blank, so the model leans on baseline.
    profile: {
      ageYears,
      sex,
    },
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo: newestDaysAgo,
    },
    [meta.id]: {
      summary,
      series: graded,
      latestDayFocus: latest
        ? { dayOffset: latest.dayOffset, value: latest.value }
        : null,
    },
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
    args.userId,
    // memory.ts keys previous context by the `insights.<scope>.<locale>`
    // action; the generic scope (`metric:<ID>-status`) carries the same
    // `-status` suffix so the comparison row reads back correctly. The
    // `getPreviousInsightContext` param is typed to accept this scope form
    // (`PreviousContextScope`), so the argument type-checks honestly.
    `${scope}-status`,
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.1 — diversity / anti-repetition context, all from already-computed
  // data (no new statistics, no new persistence). Grounding is untouched:
  // these blocks add a rotating opening angle, an explicit data-strength
  // line, a steady-run repetition signal, and the FDR-surviving cross-metric
  // correlations that involve THIS metric. The correlation fetch is
  // best-effort and decorative — a failure resolves to no block, never a
  // generation failure.
  const varietyLead = pickVarietyLead(args.userId, meta.id, todayKey);
  const steadyRun = computeSteadyRun(graded.weekly, graded.monthly);
  const relations = await getRelevantCorrelationsForMetric(
    args.userId,
    meta.measurementType,
  );
  const contextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: summary?.points ?? series.daily.length,
        newestDaysAgo,
      },
      repeatCount: steadyRun,
      relations,
    },
    locale,
  );

  const outcome = await runStatusCompletion({
    userId: args.userId,
    cacheAction,
    consentSurface: "insights",
    systemPrompt: getMetricArchetypeSystemPrompt(meta, locale),
    userPrompt: getMetricArchetypeUserPrompt(
      meta,
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      contextBlock,
    ),
    // v1.12.1 (D1) — the phrasing task benefits from a touch more sampling
    // entropy while the FACTS stay pinned by the snapshot + the
    // forbidden-phrase guards. 0.3 was conservative for a 2-4 sentence prose
    // task; 0.45 varies cadence without loosening grounding.
    temperature: 0.45,
    maxTokens: 1000,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      text: getNoKeyGeneralStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    return returnTimeoutFallback({
      cacheAction,
      reason: outcome.kind,
      userId: args.userId,
      todayKey,
      stubText: getNoKeyGeneralStatusText(locale),
    });
  }

  const text = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!text) {
    throw new Error(`Metric-status summary was empty for ${meta.id}`);
  }

  const updatedAt = await persistStatusInsight({
    userId: args.userId,
    cacheAction,
    todayKey,
    locale,
    text,
    providerType: outcome.providerType,
    model: outcome.model,
    tokensUsed: outcome.tokensUsed,
  });

  return { hasProvider: true, text, cached: false, updatedAt };
}

export function resolveMetricStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
