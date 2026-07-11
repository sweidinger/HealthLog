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
  BRIEFING_FEATURE_WINDOW_DAYS,
  type SignalOfDay,
  type AggregatedFeatures,
} from "@/lib/insights/features";
import {
  findUngroundedBriefingNumbers,
  readBriefingBlock,
  buildBriefingGroundingCorrection,
} from "@/lib/ai/briefing-grounding";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import { getCachedFeatures } from "@/lib/insights/feature-cache";
import {
  buildBriefingIllnessCycleContext,
  buildBriefingIllnessCyclePrompt,
} from "@/lib/insights/illness-cycle-briefing";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import {
  detectGlp1Plateau,
  buildGlp1PlateauPrompt,
} from "@/lib/insights/glp1-plateau";
import {
  buildUserPrompt,
  type ComparisonSnapshot,
} from "@/lib/ai/prompts/insight-system-prompt";
import {
  buildSystemPromptWithReferences,
  buildBriefingPersonalisationBlock,
} from "@/lib/ai/prompts/insight-generator";
import { buildRetryCorrectionMessage } from "@/lib/ai/generate-insight";
import { singleUserTurn } from "@/lib/ai/types";
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
import {
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
} from "@/lib/ai/consent-guard";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { stripJsonFences } from "@/lib/insights/status-shared";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { annotate } from "@/lib/logging/context";
import { AI_BUDGETS, resolveInsightsMaxTokens } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import { recordBriefingFailure } from "@/lib/insights/briefing-failure-marker";

// Scope invalidation + refill moved to a sibling module; re-exported so
// every existing call site keeps importing from here.
export * from "@/lib/insights/status-invalidation";

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
  /**
   * v1.16.8 — the content-hash gate found the compacted feature snapshot
   * unchanged since the cached text was generated. No provider call was
   * made; only `insightsCachedAt` was refreshed so the freshness windows
   * (GET read, nightly discovery) treat the cache as current.
   */
  | { status: "unchanged" }
  /**
   * v1.18.7 — the snapshot was unchanged (findings byte-stable) but the
   * daily-briefing PARAGRAPH was re-rolled at a higher, seedless
   * temperature for phrasing variety. At most one re-roll per calendar day.
   */
  | { status: "rerolled"; providerType: string }
  | { status: "skipped"; reason: "no-provider" | "no-consent" }
  | { status: "failed"; reason: string };

/** Higher, seedless temperature for the daily-briefing phrasing re-roll. */
const BRIEFING_REROLL_TEMPERATURE = 0.6;

/** UTC YYYY-MM-DD calendar-day key gating the once-per-day briefing re-roll. */
function buildRerollDateKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Re-roll ONLY the daily-briefing paragraph on a hash-unchanged hit.
 *
 * Runs the same comprehensive prompt at a higher, seedless temperature, then
 * keeps the cached payload verbatim and swaps in just the freshly-generated
 * `dailyBriefing.paragraph`. So the structured findings stay byte-stable
 * (reference assessments, monotony is fine) while the prose the user reads at
 * the top of /insights varies day-over-day. Returns null on any miss (no
 * provider success, invalid JSON, no cached/new paragraph) so the caller
 * falls back to the plain timestamp refresh.
 */
async function rerollBriefingParagraph(args: {
  userId: string;
  chain: Awaited<ReturnType<typeof resolveProviderChain>>;
  systemPrompt: string;
  userPrompt: string;
  cachedText: string;
  locale: "de" | "en";
  /**
   * v1.18.10 (MEDIUM-3) — the pre-computed signals the briefing must match.
   * The reroll runs at a higher, seedless temperature for phrasing variety,
   * which is exactly the path most prone to drifting a restated number; the
   * fresh paragraph is rejected (caller keeps the cached one) when a number in
   * it does not trace to one of these figures.
   */
  signals: readonly SignalOfDay[] | null;
  /**
   * v1.22 (W6, W8 seam) — the full feature snapshot so the grounding gate also
   * admits numbers from the W8 aggregate blocks (glucose / labs / preventive-
   * care / workouts) the reroll may now cite.
   */
  features?: AggregatedFeatures | null;
  /**
   * The upstream provider timeout for this re-roll, resolved from the user's
   * response-timeout setting (falling back to the comprehensive budget). The
   * caller resolves it once and threads it in so the re-roll honours the same
   * slow-backend allowance the main generation does.
   */
  effectiveTimeoutMs: number;
}): Promise<{ text: string; providerType: string } | null> {
  let cached: Record<string, unknown>;
  try {
    cached = JSON.parse(args.cachedText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const cachedBriefing = cached.dailyBriefing;
  // Nothing to re-roll when the cached payload carries no briefing paragraph.
  if (
    cachedBriefing === null ||
    typeof cachedBriefing !== "object" ||
    typeof (cachedBriefing as { paragraph?: unknown }).paragraph !== "string"
  ) {
    return null;
  }

  let result;
  let providerType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId: args.userId,
      providers: args.chain,
      params: singleUserTurn({
        system: args.systemPrompt,
        user: args.userPrompt,
        // Seedless on purpose: the seed would pin the same phrasing, which is
        // exactly what we are varying. Higher temperature for prose variety.
        temperature: BRIEFING_REROLL_TEMPERATURE,
        maxTokens: resolveInsightsMaxTokens(),
        // v1.21.5 — wider upstream budget so the reasoning-heavy briefing
        // generation is not clipped at the client's 60 s default mid-stream.
        // v1.25 — honours the per-user response-timeout setting (see caller).
        timeoutMs: args.effectiveTimeoutMs,
        responseFormat: "json",
      }),
    });
    result = fallback.result;
    providerType = fallback.workingProvider.providerType;
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripJsonFences(result.content)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const freshBriefing = parsed.dailyBriefing;
  const freshParagraph =
    freshBriefing && typeof freshBriefing === "object"
      ? (freshBriefing as { paragraph?: unknown }).paragraph
      : undefined;
  if (
    typeof freshParagraph !== "string" ||
    freshParagraph.trim().length === 0
  ) {
    return null;
  }

  // v1.18.10 (MEDIUM-3) — grounding gate on the rerolled paragraph. The higher
  // seedless temperature can drift a restated figure ("+1.2 kg" → "+1.3 kg");
  // reject the reroll on any ungrounded number so the caller keeps the cached
  // (already-grounded) paragraph rather than swapping in a fabricated one.
  const rerollUngrounded = findUngroundedBriefingNumbers(
    { paragraph: freshParagraph },
    args.signals,
    args.features,
  );
  if (rerollUngrounded.length > 0) {
    return null;
  }

  // Keep the cached payload verbatim; swap in only the fresh paragraph.
  const mergedBriefing = {
    ...(cachedBriefing as Record<string, unknown>),
    paragraph: freshParagraph,
  };
  const merged = { ...cached, dailyBriefing: mergedBriefing };
  return { text: JSON.stringify(merged), providerType };
}

/**
 * Parse + (best-effort) validate a comprehensive provider reply. Returns the
 * parsed payload (validated when it matches `insightResultSchema`, else the
 * raw object so the richer optional blocks survive), or null when the reply
 * is not valid JSON even after fence-stripping. Null signals the caller to
 * run its one corrective retry.
 */
function parseComprehensiveResult(
  content: string,
): InsightResult | Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch {
    return null;
  }
  const validated = insightResultSchema.safeParse(parsed);
  return validated.success
    ? validated.data
    : (parsed as Record<string, unknown>);
}

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
  // The snapshot only feeds summarize()'s avg30 / avg30LastMonth /
  // avg30LastYear. The widest of those reaches back into the [365, 395)-day
  // window (ageMs < 395 * DAY in meanOfWindow), so nothing older than 395
  // days can change a result. Bound the read at 400 days — a 5-day floor over
  // the strict-less-than boundary — instead of scanning the full history,
  // which on multi-year accounts is tens of thousands of rows per type on the
  // page-blocking generate path and the nightly pregenerate cron.
  const sinceMeasuredAt = new Date(Date.now() - 400 * 86_400_000);
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
            where: {
              userId,
              type,
              deletedAt: null,
              measuredAt: { gte: sinceMeasuredAt },
            },
            orderBy: { measuredAt: "asc" },
            select: {
              measuredAt: true,
              value: true,
              sleepStage: true,
              source: true,
              // Writer-level collapse: two HealthKit apps behind one
              // source (watch stages vs phone in-bed) must not blend.
              deviceType: true,
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
          where: {
            userId,
            type,
            deletedAt: null,
            measuredAt: { gte: sinceMeasuredAt },
          },
          orderBy: { measuredAt: "asc" },
          select: { measuredAt: true, value: true },
        });
        dataPoints = measurements.map((m): DataPoint => ({
          date: m.measuredAt,
          value: m.value,
        }));
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
   * write a cache row + timestamp the caller no longer expects. The signal
   * lets the caller cut the generation off before the cache write.
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
      insightsSnapshotHash: true,
      insightsBriefingRerollDate: true,
      // The comparison-baseline setting joins the snapshot fingerprint
      // (see the hash construction below), so it must be readable BEFORE
      // the gate — the comparison snapshot itself is only built after.
      dashboardWidgetsJson: true,
      // v1.18.11 P5 — gender feeds the cycle context block (phase contrast).
      gender: true,
      // v1.22 (W6) — first name for the sparse, hash-gated briefing opener.
      displayName: true,
      // v1.25 — per-user response-timeout (seconds). Threaded onto every
      // provider call below so a raised value for a slow self-hosted backend
      // actually applies to the briefing, not just to Coach.
      aiResponseTimeoutSeconds: true,
    },
  });

  // Resolve the upstream provider timeout once from the user's setting,
  // falling back to the comprehensive budget. Every generation call in this
  // function (main, JSON retry, grounding retry, and the paragraph re-roll)
  // uses it so the whole briefing path honours the operator's allowance.
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
    dbUser?.aiResponseTimeoutSeconds,
    AI_BUDGETS.comprehensive.timeoutMs,
  );

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
  // v1.18.11 P1 — bound the briefing's bulk feature read to a recent window
  // (all-time extremes are sourced separately, see features.ts). The downgrade
  // ladder below stays as the safety net for the rare oversize payload.
  const featureWindow = { sinceDays: BRIEFING_FEATURE_WINDOW_DAYS };
  let features: Awaited<ReturnType<typeof extractFeatures>>;
  try {
    // v1.18.11 P3 — compute-once-per-scope. Inside the nightly-tick scope (or
    // the on-demand route scope) the bounded feature read is shared, so the
    // downgrade-ladder re-reads below and any sibling consumer in the same
    // scope reuse this object instead of re-querying.
    features = await getCachedFeatures({
      userId,
      includeRaw,
      sinceDays: featureWindow.sinceDays,
      compute: () => extractFeatures(userId, includeRaw, featureWindow),
    });
  } catch (err) {
    if (err instanceof FeaturesPayloadTooLargeError) {
      try {
        features = await getCachedFeatures({
          userId,
          includeRaw: false,
          sinceDays: featureWindow.sinceDays,
          compute: () => extractFeatures(userId, false, featureWindow),
        });
      } catch (retryErr) {
        if (retryErr instanceof FeaturesPayloadTooLargeError) {
          try {
            const aggregated = await getCachedFeatures({
              userId,
              includeRaw: false,
              sinceDays: featureWindow.sinceDays,
              compute: () => extractFeatures(userId, false, featureWindow),
            });
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

  // v1.16.8 — content-hash gate. When the compacted feature snapshot is
  // byte-equivalent (modulo clock-relative offsets, see snapshot-hash.ts)
  // to the one the cached text was generated from, nothing the prompt
  // sees has changed — refresh the cache timestamp and skip the provider
  // call. This runs on the forced paths too (nightly tick, on-demand
  // warm), which is exactly where the same-data regeneration waste lived.
  //
  // The user-authored "about me" self-description joins the fingerprint:
  // it is the one prompt input that can change with NO data change (the
  // Coach remember action, a Settings → AI edit), and excluding it would
  // pin the briefing to the pre-edit self-context until a measurement
  // happens to move. The plateau block stays out — it derives from the
  // same measurement rows the feature snapshot already fingerprints.
  // Fetched once here and reused for the prompt below.
  //
  // Two more prompt inputs that can flip with no data change join the
  // composite (the shape MUST stay identical to the POST route's hash
  // write in `generate/route.ts`, or every nightly force-regenerates):
  //   - `comparisonBaseline`: the user's comparison toggle. Switching it
  //     adds/removes the prior-period context block, so the cached text
  //     no longer matches what the prompt would produce.
  //   - `generationLocale`: the locale the briefing renders in. Hashing
  //     it means a locale switch regenerates ONCE — intended, the
  //     briefing language must follow the reader; afterwards the new
  //     locale's hash is the stored baseline and the gate holds again.
  //     The key is named `generationLocale` (not `locale`) on purpose:
  //     the canonicaliser in `snapshot-hash.ts` strips `locale` keys as
  //     volatile, which is right for the per-locale-keyed status caches
  //     but would silently drop the field from THIS composite.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  const comparisonBaseline: ComparisonBaseline =
    resolveDashboardLayout(dbUser?.dashboardWidgetsJson).comparisonBaseline ??
    "none";
  const snapshotHash = hashInsightSnapshot({
    features: compactFeatures,
    aboutMe: aboutMe ?? null,
    comparisonBaseline,
    generationLocale: locale,
  });
  // v1.12.7 (B5) — the curated SOURCES block for the metrics present, shared
  // by both the full generation below and the unchanged-data re-roll.
  const referenceMetrics = metricsFromPresentSections({
    bloodPressure: features.bloodPressure != null,
    weight: features.weight != null,
    pulse: features.pulse != null,
    mood: features.mood != null,
    medication: (features.medications?.length ?? 0) > 0,
  });

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
  if (aboutMe) {
    userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
  }
  // v1.18.11 P5 — illness + cycle context (same builders as the on-demand
  // route + the Coach). Module-gated; null for users without either module.
  const illnessCycleCtx = await buildBriefingIllnessCycleContext(
    userId,
    dbUser?.gender ?? null,
    await resolveUserTimezone(userId),
  );
  if (illnessCycleCtx) {
    userPrompt += buildBriefingIllnessCyclePrompt(illnessCycleCtx, locale);
  }
  // v1.22 (W6) — opener-archetype rotation + sparse first-name personalization.
  // Both are deterministic per (user, day): the opener hint varies the briefing
  // lead day-over-day, and the name appears on roughly one day in three (never a
  // rote daily "Good morning, <name>"). The whole block is omitted when no
  // display name is set, so unnamed / demo accounts are byte-identical.
  userPrompt += buildBriefingPersonalisationBlock(
    userId,
    dbUser?.displayName ?? null,
    locale,
  );
  const systemPrompt = buildSystemPromptWithReferences(
    locale,
    referenceMetrics,
  );

  if (
    dbUser?.insightsCachedText &&
    dbUser.insightsSnapshotHash === snapshotHash
  ) {
    // v1.18.7 (MEDIUM-3) — findings are byte-stable, but re-roll the daily-
    // briefing PARAGRAPH once per calendar day so the prose reads fresh
    // day-over-day. Gated on `insightsBriefingRerollDate` so it costs at
    // most one extra call/day; the higher, seedless temperature varies the
    // phrasing while the structured findings are preserved verbatim from the
    // cached payload. Any miss falls through to the plain timestamp refresh.
    const todayKey = buildRerollDateKey();
    if (dbUser.insightsBriefingRerollDate !== todayKey) {
      const rerolled = await rerollBriefingParagraph({
        userId,
        chain,
        systemPrompt,
        userPrompt,
        cachedText: dbUser.insightsCachedText,
        locale,
        signals: features.signalsOfDay ?? null,
        features,
        effectiveTimeoutMs,
      });
      if (rerolled) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            insightsCachedAt: new Date(),
            insightsCachedText: rerolled.text,
            insightsBriefingRerollDate: todayKey,
          },
        });
        invalidateUserInsights(userId);
        annotate({
          action: { name: "insights.generate.briefing_rerolled" },
          meta: { locale, provider: rerolled.providerType },
        });
        return { status: "rerolled", providerType: rerolled.providerType };
      }
      // A re-roll miss still stamps the day so a persistently failing
      // provider cannot be re-driven on every page-open; the next day retries.
      await prisma.user.update({
        where: { id: userId },
        data: {
          insightsCachedAt: new Date(),
          insightsBriefingRerollDate: todayKey,
        },
      });
      annotate({
        action: { name: "insights.generate.skipped_unchanged" },
        meta: { locale, rerollAttempted: true },
      });
      return { status: "unchanged" };
    }
    await prisma.user.update({
      where: { id: userId },
      data: { insightsCachedAt: new Date() },
    });
    annotate({
      action: { name: "insights.generate.skipped_unchanged" },
      meta: { locale },
    });
    return { status: "unchanged" };
  }

  let result;
  let workingProviderType: string;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: singleUserTurn({
        system: systemPrompt,
        user: userPrompt,
        temperature: AI_BUDGETS.comprehensive.temperature,
        maxTokens: resolveInsightsMaxTokens(),
        // v1.21.5 — wider upstream budget so the reasoning-heavy briefing
        // generation is not clipped at the client's 60 s default mid-stream.
        // v1.25 — honours the per-user response-timeout setting.
        timeoutMs: effectiveTimeoutMs,
        // v1.18.7 — structured surface: opt the non-OpenAI chains into their
        // strongest JSON mode (Ollama `format`, Anthropic `{` prefill) so a
        // first-pass JSON miss is rarer; stripJsonFences stays the net.
        responseFormat: "json",
      }),
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
  } catch (e) {
    // v1.21.5 — make the failed generation queryable. This path used to return
    // a `failed` outcome with NO annotation, so a provider that consistently
    // failed (e.g. a codex briefing aborted by the 60 s timeout on a large
    // account) left the cached block empty AND emitted nothing the operator
    // could grep — the briefing and the insights trend narrative that share
    // the block stayed blank with no signal. No cache row is written, so the
    // next warm / visit retries; the wider `timeoutMs` above is what lets that
    // retry actually land.
    const reason =
      e instanceof AllProvidersFailedError
        ? "all-providers-failed"
        : "provider-error";
    const err = e as { httpStatus?: number; message?: string };
    annotate({
      action: { name: "insights.generate.comprehensive_failed" },
      meta: {
        locale,
        reason,
        provider_status:
          typeof err.httpStatus === "number" ? err.httpStatus : null,
        provider_message: err.message?.slice(0, 240) ?? null,
      },
    });
    // v1.25 — record a dated failure marker so the read path can surface a
    // discreet "couldn't refresh" hint alongside the preserved last-good
    // briefing. No cache row is written here, so `insightsCachedText` (the
    // last good payload) stays intact and the surface never blanks.
    void recordBriefingFailure({
      userId,
      reason,
      locale,
      httpStatus: typeof err.httpStatus === "number" ? err.httpStatus : null,
    });
    return { status: "failed", reason };
  }

  // Anthropic + local have no native JSON mode, so a ```json-fenced or
  // sentence-prefixed reply would otherwise fail the whole generation.
  // Strip the fence before parsing; clean JSON passes through unchanged.
  let insights = parseComprehensiveResult(result.content);
  if (insights === null) {
    // v1.18.7 (MEDIUM-5) — one corrective retry before declaring failure,
    // reusing the same `buildRetryCorrectionMessage` the strict insight
    // wrapper uses next door. The comprehensive path previously failed cold
    // to `invalid-json` on a first-pass miss even though the recovery helper
    // sat right there. The retry appends the correction to the user prompt
    // and re-runs the chain once.
    annotate({
      action: { name: "insights.generate.json_retry" },
      meta: { locale },
    });
    try {
      const retry = await runRawCompletionWithFallback({
        userId,
        providers: chain,
        params: singleUserTurn({
          system: systemPrompt,
          user: `${userPrompt}\n\n${buildRetryCorrectionMessage(
            "Response was not valid JSON",
            "The previous reply could not be parsed as a JSON object.",
          )}`,
          temperature: AI_BUDGETS.comprehensive.temperature,
          maxTokens: resolveInsightsMaxTokens(),
          // v1.21.5 — wider upstream budget; see the first generation call.
          // v1.25 — honours the per-user response-timeout setting.
          timeoutMs: effectiveTimeoutMs,
          responseFormat: "json",
        }),
      });
      result = retry.result;
      workingProviderType = retry.workingProvider.providerType;
    } catch {
      void recordBriefingFailure({ userId, reason: "invalid-json", locale });
      return { status: "failed", reason: "invalid-json" };
    }
    insights = parseComprehensiveResult(result.content);
    if (insights === null) {
      void recordBriefingFailure({ userId, reason: "invalid-json", locale });
      return { status: "failed", reason: "invalid-json" };
    }
  }

  // v1.18.10 (HIGH-1) — daily-briefing number-grounding gate. The cron +
  // force-warm path produces the same briefing the POST route does, so it
  // enforces the same cross-check: every number the briefing restates must
  // trace to a `features.signalsOfDay` figure. One corrective retry, then strip
  // the briefing rather than persist a fabricated number.
  {
    const signals = features.signalsOfDay ?? null;
    let retryTransportFailed = false;
    let ungrounded = findUngroundedBriefingNumbers(
      readBriefingBlock(insights),
      signals,
      features,
    );
    if (ungrounded.length > 0) {
      annotate({
        action: { name: "insights.generate.briefing_grounding_retry" },
        meta: { locale, ungroundedCount: ungrounded.length },
      });
      try {
        const retry = await runRawCompletionWithFallback({
          userId,
          providers: chain,
          params: singleUserTurn({
            system: systemPrompt,
            user: `${userPrompt}\n\n${buildBriefingGroundingCorrection(ungrounded)}`,
            temperature: AI_BUDGETS.comprehensive.temperature,
            maxTokens: resolveInsightsMaxTokens(),
            // v1.21.5 — wider upstream budget; see the first generation call.
            // v1.25 — honours the per-user response-timeout setting.
            timeoutMs: effectiveTimeoutMs,
            responseFormat: "json",
          }),
        });
        const retryInsights = parseComprehensiveResult(retry.result.content);
        const retryUngrounded = findUngroundedBriefingNumbers(
          readBriefingBlock(retryInsights),
          signals,
          features,
        );
        if (retryInsights !== null && retryUngrounded.length === 0) {
          insights = retryInsights;
          result = retry.result;
          workingProviderType = retry.workingProvider.providerType;
          ungrounded = [];
        } else {
          ungrounded = retryUngrounded;
        }
      } catch {
        // Retry failed on TRANSPORT (provider outage / timeout), not on
        // content — the model never got its correction chance.
        retryTransportFailed = true;
      }
    }
    if (ungrounded.length > 0 && insights && typeof insights === "object") {
      // A content-failed retry (the model repeated ungrounded numbers)
      // still strips hard — a fabricated figure must never persist. But
      // when the corrective retry died on transport, prefer the previous
      // payload's briefing (it passed this same gate when it was written)
      // over a hole: a day-old briefing beats a vanished one, and the next
      // successful run replaces it.
      let fallbackBriefing: unknown = null;
      if (retryTransportFailed && dbUser?.insightsCachedText) {
        try {
          const prev = JSON.parse(dbUser.insightsCachedText) as Record<
            string,
            unknown
          >;
          fallbackBriefing = prev.dailyBriefing ?? null;
        } catch {
          // Unparseable previous payload — keep the hard strip.
        }
      }
      (insights as Record<string, unknown>).dailyBriefing = fallbackBriefing;
      annotate({
        action: { name: "insights.generate.briefing_grounding_stripped" },
        meta: {
          locale,
          ungroundedCount: ungrounded.length,
          briefing_fallback:
            fallbackBriefing != null ? "previous-cached" : "stripped",
        },
      });
    }
  }

  // v1.9.0 — the caller abandoned this generation (its bounded timeout
  // fired and it has moved on to warm the per-status caches itself). Bail
  // out before the cache write so a late-resolving comprehensive cannot
  // stamp a timestamp/text the caller no longer expects. The provider call
  // already cost what it cost; what we must NOT do now is touch the cache.
  if (signal?.aborted) {
    return { status: "failed", reason: "aborted" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
      insightsSnapshotHash: snapshotHash,
    },
  });
  // v1.16.8 — no blanket per-status eviction here any more. The cards
  // track their own data through the ingest invalidator and their own
  // content-hash gates; a fresh comprehensive briefing does not change
  // what a per-metric card should say, and the old sweep was the reason
  // every warm had to regenerate ~45 cards across both locales.
  invalidateUserInsights(userId);

  return { status: "generated", providerType: workingProviderType };
}
