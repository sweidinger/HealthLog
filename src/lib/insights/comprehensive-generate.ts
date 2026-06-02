/**
 * v1.7.0 W6 — shared comprehensive-insight generator.
 *
 * The on-demand `POST /api/insights/generate` route and the nightly
 * `insight-pregenerate` cron both need to run the same pipeline:
 * resolve the provider chain → extract + compact features → build the
 * strict prompt → run the completion with fallback → parse + cache the
 * result. This module is that single source of truth so the briefing
 * the cron pre-generates is byte-identical to what an on-demand
 * regenerate would have produced.
 *
 * The route keeps its request-specific concerns (rate-limit gate,
 * locale resolution from the request, audit-with-IP). The cron supplies
 * its own budget gate (a per-user rate-limit bucket so a nightly
 * fan-out across every user can never blow the LLM budget) before
 * calling `generateComprehensiveInsight`.
 *
 * NO synchronous request lifecycle: the cron path runs entirely on
 * pg-boss, never inside an HTTP handler.
 */
import { prisma } from "@/lib/db";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
} from "@/lib/insights/features";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import {
  detectGlp1Plateau,
  buildGlp1PlateauPrompt,
} from "@/lib/insights/glp1-plateau";
import {
  buildUserPrompt,
  type ComparisonSnapshot,
} from "@/lib/ai/prompts/insight-system-prompt";
import { getStrictInsightsSystemPrompt } from "@/lib/ai/prompts/insight-generator";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import {
  resolveDashboardLayout,
  type ComparisonBaseline,
} from "@/lib/dashboard-layout";
import type { MeasurementType } from "@/generated/prisma/client";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { enqueueStatusGeneration } from "@/lib/jobs/insight-status-generate-shared";
import { normalizeLocale } from "@/lib/insights/status-shared";
import {
  metricIdForMeasurementType,
  metricStatusScope,
} from "@/lib/insights/metric-status-registry";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_DOWNGRADE_TOKENS: ReadonlyArray<string> = [
  "anthropometrics",
  "medications",
  "compliance",
  "sleep",
  "steps",
  "hrv",
  "resting_hr",
];

export type GenerateOutcome =
  | { status: "cached" }
  | { status: "generated"; providerType: string }
  | { status: "skipped"; reason: "no-provider" }
  | { status: "failed"; reason: string };

/**
 * Comparison-snapshot builder — shared with the on-demand route. Returns
 * null when the user's comparison toggle is off (most users), so the
 * prompt builder skips the context block entirely.
 */
export async function buildComparisonSnapshotForUser(
  userId: string,
): Promise<ComparisonSnapshot | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { dashboardWidgetsJson: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  const baseline: ComparisonBaseline = layout.comparisonBaseline ?? "none";
  if (baseline === "none") return null;

  const typeToSnapshotKey: Record<string, string> = {
    WEIGHT: "weight",
    BLOOD_PRESSURE_SYS: "bloodPressureSys",
    BLOOD_PRESSURE_DIA: "bloodPressureDia",
    PULSE: "pulse",
    BODY_FAT: "bodyFat",
    SLEEP_DURATION: "sleep",
    ACTIVITY_STEPS: "steps",
  };
  const typeUnits: Record<string, string> = {
    WEIGHT: "kg",
    BLOOD_PRESSURE_SYS: "mmHg",
    BLOOD_PRESSURE_DIA: "mmHg",
    PULSE: "bpm",
    BODY_FAT: "%",
    SLEEP_DURATION: "h",
    ACTIVITY_STEPS: "",
  };
  const types = Object.keys(typeToSnapshotKey) as MeasurementType[];
  const rows = await Promise.all(
    types.map(async (type) => {
      const measurements = await prisma.measurement.findMany({
        where: { userId, type, deletedAt: null },
        orderBy: { measuredAt: "asc" },
        select: { measuredAt: true, value: true },
      });
      const summary = summarize(
        measurements.map(
          (m): DataPoint => ({ date: m.measuredAt, value: m.value }),
        ),
      );
      const baselineAvg =
        baseline === "lastMonth"
          ? (summary.avg30LastMonth ?? null)
          : (summary.avg30LastYear ?? null);
      const currentAvg = summary.avg30 ?? null;
      const delta =
        currentAvg !== null && baselineAvg !== null
          ? Math.round((currentAvg - baselineAvg) * 100) / 100
          : null;
      const deltaPercent =
        delta !== null && baselineAvg !== null && baselineAvg !== 0
          ? Math.round((delta / Math.abs(baselineAvg)) * 100 * 10) / 10
          : null;
      return {
        type: typeToSnapshotKey[type] ?? type,
        currentAvg,
        baselineAvg,
        delta,
        deltaPercent,
        unit: typeUnits[type] ?? "",
      };
    }),
  );

  const metrics = rows.filter(
    (row) => row.currentAvg !== null || row.baselineAvg !== null,
  );

  return { baseline, metrics };
}

/** Evict the per-status insight cache rows (`insights.<scope>-status.<locale>`). */
export async function evictPerStatusInsightCache(
  userId: string,
): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      userId,
      action: { startsWith: "insights." },
      AND: [{ action: { contains: "-status." } }],
    },
  });
}

/**
 * The seven per-metric assessment scopes. Each generator persists its
 * cached text under `insights.<scope>-status.<locale>`; the warm-pass in
 * the nightly cron re-fills these after `evictPerStatusInsightCache`
 * clears them, and the targeted invalidator below drops only the scopes
 * a fresh measurement of a given type actually dirties.
 */
export const PER_STATUS_SCOPES = [
  "blood-pressure",
  "pulse",
  "weight",
  "bmi",
  "mood",
  "medication-compliance",
  "general",
] as const;

export type PerStatusScope = (typeof PER_STATUS_SCOPES)[number];

/**
 * Map a measurement type to the assessment scopes a fresh reading of it
 * dirties. `general` is the catch-all overview, so every measurement
 * type touches it. BMI rides on WEIGHT (it is weight ÷ height²), so a
 * new weight reading invalidates both the weight and the BMI card.
 */
function statusScopesForMeasurementType(type: MeasurementType): PerStatusScope[] {
  switch (type) {
    case "WEIGHT":
      return ["weight", "bmi", "general"];
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
      return ["blood-pressure", "general"];
    case "PULSE":
    case "RESTING_HEART_RATE":
      return ["pulse", "general"];
    default:
      // Every other tracked metric (body composition, sleep, steps,
      // glucose, …) still feeds the general overview assessment.
      return ["general"];
  }
}

/**
 * Drop the cached per-metric assessment rows that a batch of fresh
 * measurements dirties, so the next mount (or the next nightly warm
 * pass) regenerates them against the new data instead of serving the
 * pre-measurement text for the rest of the day.
 *
 * Fire-and-forget from the measurement ingest path — idempotent (a
 * redundant delete costs nothing) and never a blocker on the user's
 * write. Deletes every locale variant of each affected scope in one
 * sweep; the `-status.` substring guard keeps it from touching the
 * comprehensive cache or any unrelated `insights.*` audit row.
 */
export async function invalidateStatusInsightsForTypes(
  userId: string,
  types: Iterable<MeasurementType>,
): Promise<void> {
  const scopes = new Set<PerStatusScope>();
  // v1.8.7.1 — a fresh measurement of a type that backs a generic
  // HealthKit assessment card (the ~30 registry metrics) also dirties that
  // card's `metric:<ID>` scope. Collect those alongside the seven
  // specialised scopes so the generic tier is invalidated + re-warmed on
  // ingest with the same debounced enqueue, rather than lagging until the
  // nightly cron. Only registered, data-bearing types map here; the seven
  // specialised metrics and any unregistered type resolve to null and are
  // skipped, so the constant sync cannot fan out to unwanted scopes.
  const metricScopes = new Set<`metric:${string}`>();
  for (const type of types) {
    for (const scope of statusScopesForMeasurementType(type)) {
      scopes.add(scope);
    }
    const metricId = metricIdForMeasurementType(type);
    if (metricId) {
      metricScopes.add(metricStatusScope(metricId));
    }
  }
  if (scopes.size === 0 && metricScopes.size === 0) return;

  await prisma.auditLog.deleteMany({
    where: {
      userId,
      OR: [
        ...Array.from(scopes, (scope) => ({
          action: { startsWith: `insights.${scope}-status.` },
        })),
        ...Array.from(metricScopes, (scope) => ({
          action: { startsWith: `insights.${scope}-status.` },
        })),
      ],
    },
  });

  // v1.8.7 — regenerate-on-invalidate. Deleting the today-row alone left
  // the card to re-warm only on the user's next category open (a miss → a
  // worker round-trip while they wait) or the nightly cron. Instead,
  // proactively enqueue a debounced regenerate for each dirtied scope so
  // the cache is re-warmed in the background. The enqueue is coalesced per
  // `(user, metric, locale)` via the queue's `singletonKey` (120 s window),
  // so the constant Apple-Health sync cannot fan out a storm of jobs — a
  // burst of samples collapses into one regenerate per scope.
  // The stale-while-revalidate read keeps the previous assessment visible
  // until the fresh one lands, so the user never waits on a card.
  //
  // v1.8.7 — regenerate only the user's resolved locale, matching the
  // read-path (every `*-status` GET serves `normalizeLocale(user.locale)`).
  // Warming both locales doubled provider spend on every sync, half of it
  // for a language the user never opens. The nightly warm pass still covers
  // both locales for the rare locale switch.
  const localeRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  const locale = normalizeLocale(localeRow?.locale);
  for (const scope of scopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }
  // v1.8.7.1 — re-warm the matching generic metric scopes the same way, so
  // a freshly-synced HealthKit metric's assessment card refreshes in the
  // background instead of lagging until the nightly warm pass. Same
  // single-locale, singleton-debounced enqueue as the seven scopes above.
  for (const scope of metricScopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }
}

interface GenerateOptions {
  /** Resolved UI locale for the prompt + cache row. */
  locale: "de" | "en";
  /** Skip the 24 h cache short-circuit and force a fresh generation. */
  force?: boolean;
}

/**
 * Resolve + cache the comprehensive insight for one user. Pure
 * pipeline; no rate-limit / audit / request concerns. Returns a typed
 * outcome the caller (route or cron) can log + branch on.
 *
 * On a 24 h cache hit (and `!force`) returns `{ status: "cached" }`
 * without touching the provider chain. On a provider miss returns
 * `{ status: "skipped", reason: "no-provider" }`. Provider failures
 * map to `{ status: "failed" }` rather than throwing so a cron batch
 * loop continues to the next user.
 */
export async function generateComprehensiveInsight(
  userId: string,
  options: GenerateOptions,
): Promise<GenerateOutcome> {
  const { locale } = options;
  const force = options.force === true;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
      insightsExcludeMetrics: true,
    },
  });

  if (
    !force &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < CACHE_TTL_MS
  ) {
    return { status: "cached" };
  }

  const chain = await resolveProviderChain(userId);
  if (chain.length === 0) {
    const legacy = await resolveProvider(userId);
    if (legacy.type === "none") {
      return { status: "skipped", reason: "no-provider" };
    }
    chain.push({ providerType: "admin-openai", instance: legacy });
  }

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  let features: Awaited<ReturnType<typeof extractFeatures>>;
  try {
    features = await extractFeatures(userId, includeRaw);
  } catch (err) {
    if (err instanceof FeaturesPayloadTooLargeError) {
      try {
        features = await extractFeatures(userId, false);
      } catch (retryErr) {
        if (retryErr instanceof FeaturesPayloadTooLargeError) {
          try {
            const aggregated = await extractFeatures(userId, false);
            features = applyInsightsExcludeFilter(
              aggregated,
              MAX_DOWNGRADE_TOKENS,
            );
          } catch {
            return { status: "failed", reason: "payload-too-large" };
          }
        } else {
          return { status: "failed", reason: "features-error" };
        }
      }
    } else {
      return { status: "failed", reason: "features-error" };
    }
  }

  const excludeList = dbUser?.insightsExcludeMetrics ?? [];
  features = applyInsightsExcludeFilter(features, excludeList);
  const compactFeatures = compactSections(
    features as unknown as Record<string, unknown>,
  );
  const featuresJson = JSON.stringify(compactFeatures, null, 2);

  const comparisonSnapshot = await buildComparisonSnapshotForUser(userId);
  const plateauContext = await detectGlp1Plateau(userId);
  let userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
    comparisonSnapshot ?? undefined,
  );
  if (plateauContext) {
    userPrompt += buildGlp1PlateauPrompt(plateauContext, locale);
  }

  let result;
  let workingProviderType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        systemPrompt: getStrictInsightsSystemPrompt(locale),
        userPrompt,
        temperature: 0.3,
        maxTokens: 1500,
      },
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
  } catch (e) {
    if (e instanceof AllProvidersFailedError) {
      return { status: "failed", reason: "all-providers-failed" };
    }
    return { status: "failed", reason: "provider-error" };
  }

  let insights: InsightResult | Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.content);
    const validated = insightResultSchema.safeParse(parsed);
    insights = validated.success ? validated.data : parsed;
  } catch {
    return { status: "failed", reason: "invalid-json" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
    },
  });
  await evictPerStatusInsightCache(userId);
  invalidateUserInsights(userId);

  return { status: "generated", providerType: workingProviderType };
}
