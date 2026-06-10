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
import { buildSystemPromptWithReferences } from "@/lib/ai/prompts/insight-generator";
import {
  buildAboutMeInsightBlock,
  getSelfContextTextForUser,
} from "@/lib/ai/coach/about-me";
import { metricsFromPresentSections } from "@/lib/ai/medical-references";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveUserTimezone } from "@/lib/tz/resolver";
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
import { chainRequiresServerManagedConsent, hasActiveConsentForSurface } from "@/lib/ai/consent-guard";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import {
  enqueueStatusGeneration,
  type InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import {
  normalizeLocale,
  stripJsonFences,
} from "@/lib/insights/status-shared";
import {
  isTimeoutStub,
  statusCacheAction,
  statusCacheActionPrefix,
} from "@/lib/insights/status-cache";
import {
  metricIdForMeasurementType,
  metricStatusScope,
} from "@/lib/insights/metric-status-registry";
import { annotate } from "@/lib/logging/context";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Debounce window for ingest-driven status invalidation. A scope whose
 * cached assessment was (re)generated within this window is left intact on
 * a fresh measurement ingest — neither evicted nor re-enqueued.
 *
 * A constantly-syncing client (Apple Health drips batches every few
 * minutes) used to delete + re-enqueue every dirtied scope on every batch,
 * and because each delete dropped the cache row the per-(user,scope,locale)
 * enqueue singleton (120 s) could not coalesce across batches that arrive
 * minutes apart — so STEPS / general / a metric card regenerated several
 * times an hour and the assessment felt "regenerated on every visit". This
 * window coalesces the storm: a genuinely stale scope (no fresh assessment)
 * still refreshes immediately, but a scope refreshed inside the window is
 * skipped, so a fresh assessment survives the day's sync drip and a burst
 * of batches costs at most one regeneration per scope per window.
 *
 * 30 min is comfortably longer than a typical sync cadence yet far shorter
 * than the 24 h assessment TTL, so a card still tracks new data within the
 * same session without thrashing the provider.
 */
const INGEST_INVALIDATE_DEBOUNCE_MS = 30 * 60 * 1000;

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
  | { status: "skipped"; reason: "no-provider" | "no-consent" }
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
      // SLEEP_DURATION is stored ONE ROW PER STAGE per night; summarising the
      // raw stage rows mislabels a per-stage average as a night total (and
      // double-counts a bare ASLEEP aggregate against its granular twin). Route
      // the comparison through the per-night dedup reconstruction so the
      // current/baseline averages are per-night TIME-ASLEEP totals in minutes.
      let dataPoints: DataPoint[];
      if (type === "SLEEP_DURATION") {
        const [sleepRows, sleepTz, sleepPriority] = await Promise.all([
          prisma.measurement.findMany({
            where: { userId, type, deletedAt: null },
            orderBy: { measuredAt: "asc" },
            select: {
              measuredAt: true,
              value: true,
              sleepStage: true,
              source: true,
            },
          }),
          resolveUserTimezone(userId),
          loadUserSourcePriority(userId),
        ]);
        dataPoints = reconstructSleepNights(
          sleepRows as SleepStageRow[],
          sleepTz,
          sleepPriority,
        )
          .filter((n) => n.asleepMinutes > 0)
          .map((n) => ({ date: n.measuredAt, value: n.asleepMinutes }));
      } else {
        const measurements = await prisma.measurement.findMany({
          where: { userId, type, deletedAt: null },
          orderBy: { measuredAt: "asc" },
          select: { measuredAt: true, value: true },
        });
        dataPoints = measurements.map(
          (m): DataPoint => ({ date: m.measuredAt, value: m.value }),
        );
      }
      const summary = summarize(dataPoints);
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
  // One ordered set of every scope the batch dirties. The seven specialised
  // scopes are bare slugs (`weight`, `general`, …); the generic HealthKit
  // cards (v1.8.7.1) carry a `metric:<ID>` prefix. Both share the cache-key
  // shape `insights.<scope>-status.<locale>`, so a single set covers the
  // eviction + the debounce filter + the enqueue uniformly. Only registered,
  // data-bearing types contribute a generic scope; the seven specialised
  // metrics and any unregistered type resolve to null and are skipped, so
  // the constant sync cannot fan out to unwanted scopes.
  const scopes = new Set<InsightStatusScope>();
  for (const type of types) {
    for (const scope of statusScopesForMeasurementType(type)) {
      scopes.add(scope);
    }
    const metricId = metricIdForMeasurementType(type);
    if (metricId) {
      scopes.add(metricStatusScope(metricId));
    }
  }
  if (scopes.size === 0) return;

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

  // v1.9.0 — debounce the ingest-invalidation storm. A constantly-syncing
  // client drips batches every few minutes; deleting + re-enqueuing every
  // dirtied scope on every batch regenerated the same card several times an
  // hour (the per-(user,scope,locale) enqueue singleton is only 120 s, so it
  // could not coalesce across batches arriving minutes apart, and each
  // delete dropped the row a fresh enqueue would otherwise have found warm).
  // Skip any scope whose cached assessment was (re)generated within the
  // debounce window — leave its row intact and do NOT re-enqueue. A
  // genuinely stale or missing scope still refreshes immediately, so
  // correctness holds; only the redundant churn is removed.
  const freshScopes = await findRecentlyWarmedScopes(userId, locale, scopes);
  const staleScopes = Array.from(scopes).filter(
    (scope) => !freshScopes.has(scope),
  );
  if (staleScopes.length === 0) {
    annotate({
      action: { name: "insights.status.invalidate.debounced" },
      meta: { skipped: scopes.size, refreshed: 0 },
    });
    return;
  }

  // Drop the cached per-metric assessment rows that are actually stale, so
  // the next mount / nightly warm pass regenerates them against the new
  // data. The `-status.` substring guard keeps the sweep off the
  // comprehensive cache and any unrelated `insights.*` audit row.
  await prisma.auditLog.deleteMany({
    where: {
      userId,
      OR: staleScopes.map((scope) => ({
        action: { startsWith: statusCacheActionPrefix(scope) },
      })),
    },
  });

  // v1.8.7 — regenerate-on-invalidate. Deleting the today-row alone left
  // the card to re-warm only on the user's next category open (a miss → a
  // worker round-trip while they wait) or the nightly cron. Instead,
  // proactively enqueue a debounced regenerate for each dirtied scope so
  // the cache is re-warmed in the background. The enqueue is coalesced per
  // `(user, metric, locale)` via the queue's `singletonKey` (120 s window);
  // the debounce above is the second, wider coalescing layer that survives
  // across the sync drip. The stale-while-revalidate read keeps the
  // previous assessment visible until the fresh one lands.
  for (const scope of staleScopes) {
    void enqueueStatusGeneration({ userId, metric: scope, locale });
  }

  annotate({
    action: { name: "insights.status.invalidate.debounced" },
    meta: { skipped: freshScopes.size, refreshed: staleScopes.length },
  });
}

/**
 * v1.9.0 — return the subset of `scopes` whose cached assessment for
 * `locale` was generated within `INGEST_INVALIDATE_DEBOUNCE_MS` and is a
 * real (non-stub) assessment. Those scopes are skipped by the ingest
 * invalidator so a fresh assessment survives the sync drip.
 *
 * One indexed read per user (a single `findMany` over this user's recent
 * status-cache rows, newest-first) answers it for every candidate scope at
 * once — cheaper than a per-scope probe and bounded by `take`. A timeout
 * stub never counts as fresh (it carries no real assessment), so a scope
 * that recently stalled still gets a retry enqueued.
 */
async function findRecentlyWarmedScopes(
  userId: string,
  locale: "de" | "en",
  scopes: ReadonlySet<InsightStatusScope>,
): Promise<Set<InsightStatusScope>> {
  const cutoff = new Date(Date.now() - INGEST_INVALIDATE_DEBOUNCE_MS);
  // Match exactly the cache actions for the candidate scopes in this locale.
  const candidateActions = Array.from(scopes, (scope) =>
    statusCacheAction(scope, locale),
  );
  const actionToScope = new Map<string, InsightStatusScope>();
  for (const scope of scopes) {
    actionToScope.set(statusCacheAction(scope, locale), scope);
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      userId,
      action: { in: candidateActions },
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: "desc" },
    select: { action: true, details: true },
  });

  const fresh = new Set<InsightStatusScope>();
  for (const row of rows) {
    const scope = actionToScope.get(row.action);
    if (!scope || fresh.has(scope)) continue;
    if (!row.details) continue;
    try {
      const parsed = JSON.parse(row.details) as {
        model?: string;
        timeout?: boolean;
        text?: string;
      };
      // A stub is not a real assessment — let a stalled scope retry.
      if (isTimeoutStub(parsed)) continue;
      if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
        continue;
      }
      fresh.add(scope);
    } catch {
      // Malformed payload — treat as not-fresh so the scope refreshes.
      continue;
    }
  }
  return fresh;
}

interface GenerateOptions {
  /** Resolved UI locale for the prompt + cache row. */
  locale: "de" | "en";
  /** Skip the 24 h cache short-circuit and force a fresh generation. */
  force?: boolean;
  /**
   * v1.9.0 — abort the generation when the caller has given up on it.
   *
   * The on-demand `forceWarmUser` path bounds the comprehensive step with a
   * timeout and then proceeds to warm the per-status caches itself. Without
   * this signal a comprehensive that resolves AFTER the timeout would still
   * reach `evictPerStatusInsightCache` and delete the rows the warm passes
   * had just written — undoing its own work. The signal lets the caller cut
   * the generation off before the eviction so the warmed rows survive.
   */
  signal?: AbortSignal;
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
  const signal = options.signal;

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

  // v1.12.1 — consent gate before any server-managed external egress. This
  // pipeline runs off-request (nightly cron + on-demand force-warm), so a
  // missing receipt is a typed `skipped` outcome rather than a throw — the
  // cron batch continues to the next user. BYOK / local / ChatGPT-OAuth
  // chains never trip the check.
  if (
    chainRequiresServerManagedConsent(chain) &&
    !(await hasActiveConsentForSurface(userId, "insights"))
  ) {
    return { status: "skipped", reason: "no-consent" };
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
  // v1.15.20 — fold the user-authored "about me" self-description
  // (Settings → AI) into the nightly briefing exactly like the
  // on-demand route. Null (no text / undecryptable) costs nothing.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  if (aboutMe) {
    userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
  }

  // v1.12.7 (B5) — inject the curated SOURCES block for the metric sections
  // this generation actually carries, so a normative claim ("target < 140/90")
  // can cite a real `referenceId` the schema + UI footnote already support.
  // Returns the plain prompt unchanged when no applicable metric is present.
  const referenceMetrics = metricsFromPresentSections({
    bloodPressure: features.bloodPressure != null,
    weight: features.weight != null,
    pulse: features.pulse != null,
    mood: features.mood != null,
    medication: (features.medications?.length ?? 0) > 0,
  });

  let result;
  let workingProviderType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        systemPrompt: buildSystemPromptWithReferences(locale, referenceMetrics),
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
    // Anthropic + local have no native JSON mode, so a ```json-fenced or
    // sentence-prefixed reply would otherwise fail the whole generation.
    // Strip the fence before parsing; clean JSON passes through unchanged.
    const parsed = JSON.parse(stripJsonFences(result.content));
    const validated = insightResultSchema.safeParse(parsed);
    insights = validated.success ? validated.data : parsed;
  } catch {
    return { status: "failed", reason: "invalid-json" };
  }

  // v1.9.0 — the caller abandoned this generation (its bounded timeout
  // fired and it has moved on to warm the per-status caches itself). Bail
  // out before the write + evict so a late-resolving comprehensive can never
  // delete the rows the warm passes have since written. The provider call
  // already cost what it cost; what we must NOT do now is touch the cache.
  if (signal?.aborted) {
    return { status: "failed", reason: "aborted" };
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
