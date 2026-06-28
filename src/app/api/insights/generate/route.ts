import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  extractFeatures,
  FeaturesPayloadTooLargeError,
  BRIEFING_FEATURE_WINDOW_DAYS,
} from "@/lib/insights/features";
import { applyInsightsExcludeFilter } from "@/lib/insights/exclude-filter";
import {
  getCachedFeatures,
  withFeatureCacheScope,
} from "@/lib/insights/feature-cache";
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
  detectDerivedBriefingSignals,
  buildDerivedBriefingPrompt,
} from "@/lib/insights/derived-briefing";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  buildUserPrompt,
  type ComparisonSnapshot,
} from "@/lib/ai/prompts/insight-system-prompt";
import {
  buildSystemPromptWithReferences,
  buildBriefingPersonalisationBlock,
} from "@/lib/ai/prompts/insight-generator";
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
import {
  insightResultSchema,
  singleUserTurn,
  type InsightResult,
} from "@/lib/ai/types";
import { AI_BUDGETS } from "@/lib/ai/ai-budgets";
import { resolveEffectiveTimeoutMs } from "@/lib/ai/effective-timeout";
import {
  recordBriefingFailure,
  readBriefingFailure,
} from "@/lib/insights/briefing-failure-marker";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import {
  findUngroundedBriefingNumbers,
  readBriefingBlock,
  buildBriefingGroundingCorrection,
} from "@/lib/ai/briefing-grounding";
import { isLegacyInsightPayload } from "@/lib/ai/legacy-payload";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { invalidateUserInsights } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { hasUsableStatusProvider } from "@/lib/insights/status-provider";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { enqueueForceWarm } from "@/lib/jobs/insight-pregenerate-shared";
import { enqueueStatusRefillForUser } from "@/lib/insights/comprehensive-generate";

export const dynamic = "force-dynamic";

/**
 * Briefing freshness window for the read-only GET. A cached briefing read
 * this recently is fresh and triggers no warm; older / missing enqueues an
 * out-of-band regeneration. Mirrors the 24 h cache-hit window the POST path
 * honours so the two stay consistent.
 */
const BRIEFING_FRESH_MS = 24 * 60 * 60 * 1000;

const DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR = 10;

/**
 * Reads `INSIGHTS_RATE_LIMIT_PER_HOUR` from the environment with a
 * sensible 10/hour default. The previous hard-coded 2/hour limit (from
 * v1.4 P13) was too aggressive for users iterating on settings or
 * regenerating after adding measurements. Operators who run on a
 * stricter LLM budget can dial it down via env without redeploying
 * code; values <1 fall back to the default.
 */
export function resolveInsightsRateLimit(): number {
  const raw = process.env.INSIGHTS_RATE_LIMIT_PER_HOUR;
  if (!raw) return DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_INSIGHTS_RATE_LIMIT_PER_HOUR;
  }
  return parsed;
}

/**
 * v1.4.16 phase B8 — fetch the user's persisted comparison toggle and
 * build a `ComparisonSnapshot` for the prompt builder. Returns null
 * when comparison is off (most users), so the prompt builder skips
 * the context block entirely.
 *
 * Snapshot construction reuses the analytics `summarize()` helper
 * (which now emits `avg30LastMonth` + `avg30LastYear`) so the numbers
 * the LLM sees match the numbers the dashboard tile renders — no
 * second source of truth for the comparison delta.
 */
async function buildComparisonSnapshotForUser(
  userId: string,
): Promise<ComparisonSnapshot | null> {
  // The features payload doesn't carry prior-period values — pulling
  // a fresh `summarize()` per metric below keeps the snapshot
  // self-contained without retrofitting features.ts.
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { dashboardWidgetsJson: true },
  });
  const layout = resolveDashboardLayout(row?.dashboardWidgetsJson);
  const baseline: ComparisonBaseline = layout.comparisonBaseline ?? "none";
  if (baseline === "none") return null;

  // Pull every measurement type once and run summarize() so the
  // prior-period averages line up with what the dashboard analytics
  // computes. Only include rows where the LLM can sensibly narrate
  // a prior comparison (i.e. the metric exists in our snapshot type
  // mapping below).
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

  // Drop fully-empty rows (current AND baseline missing) so the prompt
  // doesn't pad with noise. Keep partial rows (one side null) — the
  // block renderer flags them with "no prior-period data available"
  // which is useful context for the model.
  const metrics = rows.filter(
    (row) => row.currentAvg !== null || row.baselineAvg !== null,
  );

  return { baseline, metrics };
}

/**
 * GET /api/insights/generate — read-only advisor read.
 *
 * The advisor consumers (hero strip, daily-briefing card, trends row) used
 * to mount against the POST handler, which generates inline on a cache miss
 * and blocks the page-load path on the full provider chain (up to the
 * client's 8 s abort). This read-only GET serves the cached payload from
 * `User.insightsCachedText` immediately — NEVER calling the provider — and,
 * when the cache is stale / missing AND a provider is configured, enqueues
 * an out-of-band warm (the same `insight-pregenerate` queue the nightly
 * cron and the "prepare assessments" button use). The next read reflects
 * the fresh briefing. User-initiated regeneration stays on the POST path.
 *
 * `userId` is narrowed from the session / Bearer — never a body field.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  // Same surface gate as the POST + the read-only status routes: a user
  // with assessments enabled but Coach disabled still reads the cached
  // briefing.
  await requireAssistantSurface("coach");
  const userId = user.id;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsCachedAt: true,
      insightsCachedText: true,
      locale: true,
    },
  });

  const cachedAt = dbUser?.insightsCachedAt ?? null;
  const isFresh =
    cachedAt !== null && Date.now() - cachedAt.getTime() < BRIEFING_FRESH_MS;

  // v1.18.9 (#4) — resolve provider availability once, up front. The
  // read path never blocks on or generates through the provider, but it
  // must REPORT whether one exists: a provider-less account's cached
  // briefing freezes at the last successful generation (the pregenerate
  // cron can't refill it), and the UI presented that stale text as
  // current. Surfacing `hasProvider: false` lets the insights surfaces
  // pair the honest "Stand: vor X Tagen" age with a discreet
  // connect-an-AI-provider hint instead of implying the read is live.
  const hasProvider = await hasUsableStatusProvider(userId);

  // v1.25 — surface whether the most recent generation attempt failed (a
  // marker newer than the last successful generation). The briefing keeps its
  // last good text on failure, so this is the only honest signal that a shown
  // briefing is held rather than freshly refreshed — and, when there is no
  // last good text, that the empty state should read "couldn't generate" with
  // a retry rather than the generic "no briefing yet".
  const generationFailed =
    (await readBriefingFailure({ userId, since: cachedAt })) !== null;

  // Read-only: never block on the provider. Warm out of band only when the
  // cached briefing is stale / missing AND a provider is configured (a
  // provider-less account costs one cheap chain-resolve and shows the
  // empty / connect-AI state instead of a wasted enqueue).
  let revalidating = false;
  if (!isFresh && hasProvider) {
    // Resolve the locale the caller is actually reading (cookie /
    // Accept-Language fall-back when `User.locale` is unset) and narrow
    // non-German to English — the same convention the nightly's
    // `normalizeLocale` and the status routes follow. The previous
    // `(locale) === "en" ? "en" : "de"` collapsed a NULL `User.locale`
    // to German even for a client reading the app in English, so the
    // visit-triggered warm filled the wrong cache family.
    const resolved = await resolveServerLocale({
      request,
      userLocale: dbUser?.locale ?? user.locale ?? null,
    });
    const locale = resolved === "de" ? "de" : "en";
    void enqueueForceWarm({ userId, locale });
    revalidating = true;
  }

  if (dbUser?.insightsCachedText) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText);
      const legacyPayload = isLegacyInsightPayload(cached);
      annotate({
        action: { name: "insights.generate.read" },
        meta: { cached: true, legacyPayload, revalidating, hasProvider },
      });
      return apiSuccess({
        insights: cached,
        cached: true,
        cachedAt,
        legacyPayload,
        // Honest stale-serve marker: true while the out-of-band warm is
        // in flight, so the client can poll (bounded) until the fresh
        // briefing lands instead of sitting on the stale payload for the
        // rest of the session.
        revalidating,
        // v1.18.9 (#4) — false when no AI provider is configured anywhere:
        // the served briefing can never refresh, so the UI pairs its age
        // with a connect-provider affordance.
        hasProvider,
        // v1.25 — true when the last generation attempt failed (held text).
        generationFailed,
      });
    } catch {
      // Invalid cache row — fall through to the empty payload below. The
      // warm enqueue above (when a provider exists) repairs it for the
      // next read.
    }
  }

  annotate({
    action: { name: "insights.generate.read" },
    meta: { cached: false, revalidating, hasProvider },
  });
  return apiSuccess({
    insights: null,
    cached: false,
    legacyPayload: false,
    revalidating,
    // v1.18.9 (#4) — see the cached branch above.
    hasProvider,
    // v1.25 — no last-good text AND the last attempt failed: the UI shows a
    // "couldn't generate" empty state with a retry instead of the generic one.
    generationFailed,
  });
});

export const POST = apiHandler((request: NextRequest) =>
  // v1.18.11 P3 — open a request-scoped feature cache so the bounded feature
  // read is computed once and reused across the downgrade ladder (and any
  // sibling consumer) for this request.
  withFeatureCacheScope(async () => {
    const { user } = await requireAuth();
    // v1.4.31 — the advisor + daily briefing surfaces ride this
    // endpoint. Operator disables Coach, every advisor consumer
    // (briefing card, recommendations grid, hero strip narration)
    // empties out.
    await requireAssistantSurface("coach");
    const userId = user.id;

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        insightsPrivacyMode: true,
        insightsCachedAt: true,
        insightsCachedText: true,
        // v1.4.36 W3 T3 — per-user opt-out list mirroring the Coach
        // settings. Filtered off `features` before serialisation so the
        // LLM never sees the excluded blocks.
        insightsExcludeMetrics: true,
        locale: true,
        // v1.10.0 — profile for the derived-signal briefing detector.
        dateOfBirth: true,
        gender: true,
        heightCm: true,
        // v1.22 (W6) — first name for the sparse, hash-gated briefing opener.
        displayName: true,
        // v1.25 — per-user response-timeout (seconds), threaded onto the
        // generation calls so a slow self-hosted backend honours the setting.
        aiResponseTimeoutSeconds: true,
      },
    });

    const effectiveTimeoutMs = resolveEffectiveTimeoutMs(
      dbUser?.aiResponseTimeoutSeconds,
      AI_BUDGETS.comprehensive.timeoutMs,
    );

    const locale = await resolveServerLocale({
      request,
      userLocale: dbUser?.locale ?? user.locale ?? null,
    });

    const { data: body, error: jsonError } = await safeJson<{
      force?: unknown;
    }>(request, { maxBytes: 16 * 1024 });
    if (jsonError) return jsonError;
    const forceRefresh = body.force === true;

    if (
      !forceRefresh &&
      dbUser?.insightsCachedAt &&
      dbUser.insightsCachedText &&
      Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
    ) {
      try {
        const cached = JSON.parse(dbUser.insightsCachedText);
        // v1.4.16 B5c: detect legacy payloads (pre-rationale) so the UI
        // can show a "regenerate for new explainability features" CTA.
        // We don't auto-regenerate — that would burn rate-limit tokens
        // on a cache-hit silently. User-initiated only.
        const legacyPayload = isLegacyInsightPayload(cached);
        annotate({
          action: { name: "insights.generate" },
          meta: { cached: true, legacyPayload },
        });
        return apiSuccess({
          insights: cached,
          cached: true,
          cachedAt: dbUser.insightsCachedAt,
          legacyPayload,
        });
      } catch {
        // Invalid cache, regenerate
      }
    }

    // P13: rate-limit check moved BELOW the cache return so a hit on the
    // 24h cache never burns one of the LLM-generation tokens. Otherwise a
    // noisy reload loop on the dashboard would lock out real refreshes
    // for an hour for no benefit.
    //
    // v1.4.16 A7: limit raised from 2 → 10 per hour (env-configurable via
    // `INSIGHTS_RATE_LIMIT_PER_HOUR`). The 2/hour limit triggered too
    // aggressively when a user iterated on settings or regenerated after
    // adding a few measurements; 10/hour still cleanly bounds cost while
    // staying out of the way for legitimate use.
    const limit = resolveInsightsRateLimit();
    const rl = await checkRateLimit(
      `insights:${userId}`,
      limit,
      60 * 60 * 1000,
    );
    if (!rl.allowed) {
      return apiError(`Maximum ${limit} insight generations per hour.`, 429);
    }

    // v1.4.16 phase B5b: resolve the user's full provider chain so a hard
    // failure on the primary (401, 5xx, network) cascades to the next
    // configured fallback rather than surfacing a 503/422 to the
    // dashboard. Falls back to the single-provider resolution when the
    // chain comes back empty AND the legacy `aiProvider` field still
    // points at something usable — preserving v1.4.15 behaviour for
    // accounts that haven't customised the chain.
    const chain = await resolveProviderChain(userId);
    if (chain.length === 0) {
      // Try the legacy single-provider path one more time so users who
      // configured AI before v1.4.16 don't suddenly see the 422.
      const legacy = await resolveProvider(userId);
      if (legacy.type === "none") {
        return apiError(
          "No AI provider configured. Connect ChatGPT in settings or ask your admin to set up an API key.",
          422,
        );
      }
      chain.push({ providerType: "admin-openai", instance: legacy });
    }

    // v1.12.1 — consent gate before any server-managed external egress.
    // Required for the operator's global key (`admin-openai`); BYOK / local /
    // ChatGPT-OAuth chains stay ungated. Throws ConsentRequiredError →
    // apiHandler returns 403 + `consent.ai.required`.
    await assertConsentForChain({ userId, chain, surface: "insights" });

    const includeRaw = dbUser?.insightsPrivacyMode === "raw";
    // v1.4.36 W3 T1 — `extractFeatures` enforces a 5 MB ceiling on the
    // serialised payload. If the raw (bucketed) shape ever blows past
    // it (regression watch — the v1.4.35 rawMeasurements shape hit
    // 25.9 MB on the largest tenant), the helper throws
    // `FeaturesPayloadTooLargeError`. We downgrade to the aggregated
    // shape rather than 500-ing so the user still gets an insight; the
    // annotate event surfaces the regression to ops via the Logflare
    // pipeline.
    let features: Awaited<ReturnType<typeof extractFeatures>>;
    let payloadDowngraded = false;
    let payloadOversizeBytes: number | null = null;
    // v1.4.36 QA H1 — extra fallback when even the aggregated shape
    // crosses the 5 MB ceiling (very large medication history + multi-
    // year context). Strips anthropometrics + medications + every other
    // exclude-token-mapped block and tries one more time. On a third
    // failure we return 422 with an annotate event for ops visibility
    // rather than 500-ing out of an uncaught throw.
    const MAX_DOWNGRADE_TOKENS: ReadonlyArray<string> = [
      "anthropometrics",
      "medications",
      "compliance",
      "sleep",
      "steps",
      "hrv",
      "resting_hr",
    ];
    let payloadHardDowngraded = false;
    // v1.18.11 P1 — bound the briefing's bulk feature read to a recent window
    // (all-time extremes are sourced separately, see features.ts). The downgrade
    // ladder below stays as the safety net for the rare oversize payload.
    const featureWindow = { sinceDays: BRIEFING_FEATURE_WINDOW_DAYS };
    try {
      // v1.18.11 P3 — compute-once-per-request: the scope opened around this
      // handler shares the bounded feature read across the downgrade ladder.
      features = await getCachedFeatures({
        userId,
        includeRaw,
        sinceDays: featureWindow.sinceDays,
        compute: () => extractFeatures(userId, includeRaw, featureWindow),
      });
    } catch (err) {
      if (err instanceof FeaturesPayloadTooLargeError) {
        payloadDowngraded = true;
        payloadOversizeBytes = err.sizeBytes;
        try {
          features = await getCachedFeatures({
            userId,
            includeRaw: false,
            sinceDays: featureWindow.sinceDays,
            compute: () => extractFeatures(userId, false, featureWindow),
          });
        } catch (retryErr) {
          if (retryErr instanceof FeaturesPayloadTooLargeError) {
            // Aggregated shape ALSO crossed the ceiling. Drop optional
            // context blocks (anthropometrics, medications, sleep,
            // steps, hrv, resting_hr) via the existing exclude filter
            // and try once more.
            payloadHardDowngraded = true;
            payloadOversizeBytes = retryErr.sizeBytes;
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
            } catch (finalErr) {
              // Even the aggregated read itself blew up. Annotate and
              // return 422 rather than let the uncaught throw 500 out.
              annotate({
                meta: {
                  insights_payload_too_large: true,
                  insights_payload_oversize_bytes:
                    finalErr instanceof FeaturesPayloadTooLargeError
                      ? finalErr.sizeBytes
                      : payloadOversizeBytes,
                },
              });
              return apiError(
                "Your data exceeds the AI payload size limit. Reduce the data window or exclude optional blocks in Settings > AI.",
                422,
              );
            }
          } else {
            throw retryErr;
          }
        }
      } else {
        throw err;
      }
    }
    // v1.4.36 W3 T3 — apply the user's exclude-metrics opt-out list
    // BEFORE serialisation so the model never sees the dropped blocks.
    const excludeList = dbUser?.insightsExcludeMetrics ?? [];
    features = applyInsightsExcludeFilter(features, excludeList);
    // v1.4.36 W3 T4 — drop zero-row blocks so the prompt never carries
    // labelled-empty sections (`"sleep": []`, `"medications": []`,
    // etc.). Prevents the model from narrating "there are no
    // medications in your data" when the user explicitly excluded the
    // block.
    const compactFeatures = compactSections(
      features as unknown as Record<string, unknown>,
    );
    const featuresJson = JSON.stringify(compactFeatures, null, 2);
    if (payloadDowngraded) {
      annotate({
        meta: {
          insights_features_downgraded: true,
          insights_features_oversize_bytes: payloadOversizeBytes,
          insights_features_hard_downgraded: payloadHardDowngraded,
        },
      });
    }

    // v1.4.16 phase B8 — pick up the user's persisted comparison toggle
    // and, when active, build a compact prior-period snapshot from the
    // `features` summaries that already include `avg30LastMonth` /
    // `avg30LastYear` (added in the analytics summarize() helper). The
    // narrative is default-on whenever the toggle is on per research §7
    // Q4 — the pulldown is the single affordance.
    const comparisonSnapshot = await buildComparisonSnapshotForUser(userId);
    // v1.4.25 W4d — GLP-1 plateau detector. Appends a SYSTEM CONTEXT
    // block to the user prompt when the active GLP-1 medication has been
    // on a stable dose for ≥21 days with weight delta within ±0.5 kg.
    // The block instructs the model to emit a glp1_plateau keyFinding
    // framed observationally (no dose recommendation per GROUND RULE 13).
    // Returns null when no GLP-1 is active OR no plateau condition;
    // 99% of users land in the null branch and pay zero token cost.
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
    // (Settings → AI) into the briefing as a delimited, user-provided
    // SYSTEM CONTEXT block. Null (no text / undecryptable) costs nothing.
    const aboutMe = await getSelfContextTextForUser(userId, locale);
    if (aboutMe) {
      userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
    }
    // v1.10.0 — fold a notable derived wellness signal (readiness / recovery
    // shift, confidence-gated) into the briefing as a SYSTEM CONTEXT block.
    // Reads the one derived contract; null (the common case) costs nothing.
    const derivedSex =
      dbUser?.gender === "MALE" || dbUser?.gender === "FEMALE"
        ? (dbUser.gender as "MALE" | "FEMALE")
        : null;
    const derivedBriefing = await detectDerivedBriefingSignals(userId, {
      ageYears: getAgeFromDateOfBirth(dbUser?.dateOfBirth ?? null),
      sex: derivedSex,
      heightCm: dbUser?.heightCm ?? null,
    });
    if (derivedBriefing) {
      userPrompt += buildDerivedBriefingPrompt(derivedBriefing, locale);
    }

    // v1.18.11 P5 — fold illness-episode + cycle state into the briefing so a
    // mid-illness or mid-cycle user gets context-aware prose. Reuses the same
    // server-authoritative builders the Coach assembles; both are module-gated
    // and short-circuit to null (zero token cost) for users without them.
    const illnessCycleCtx = await buildBriefingIllnessCycleContext(
      userId,
      dbUser?.gender ?? null,
      await resolveUserTimezone(userId),
    );
    if (illnessCycleCtx) {
      userPrompt += buildBriefingIllnessCyclePrompt(illnessCycleCtx, locale);
    }

    // v1.22 (W6) — opener-archetype rotation + sparse first-name personalization
    // (deterministic per user+day; omitted for unnamed accounts).
    userPrompt += buildBriefingPersonalisationBlock(
      userId,
      dbUser?.displayName ?? null,
      locale,
    );

    // v1.12.7 (B5) — inject the curated SOURCES block for the metric sections
    // this briefing actually carries, so a normative claim can cite a real
    // `referenceId` the schema + UI footnote already support. Returns the plain
    // prompt unchanged when no applicable metric section is present.
    const referenceMetrics = metricsFromPresentSections({
      bloodPressure: features.bloodPressure != null,
      weight: features.weight != null,
      pulse: features.pulse != null,
      mood: features.mood != null,
      medication: (features.medications?.length ?? 0) > 0,
    });

    let result;
    let workingProviderType: string;
    let fallbackHopCount = 0;
    try {
      const fallback = await runRawCompletionWithFallback({
        userId,
        providers: chain,
        params: singleUserTurn({
          // The strict prompt (PROMPT_VERSION 4.20.x) carries GROUND RULE 8
          // — emit a top-level `dailyBriefing` block when the snapshot has
          // analysable signal — plus the trendAnnotations and
          // storyboardAnnotations rules. The legacy `getInsightsSystemPrompt`
          // returned the v1.4.5 `{changed, stable, drivers, …}` shape and
          // never asked the model for dailyBriefing, so the hero strip's
          // "Re-run analysis" button kept producing a payload with no
          // briefing block (Issue 1, v1.4.20 post-deploy). The route already
          // tolerates the strict shape via `insightResultSchema.safeParse`'s
          // soft fallback to `parsed` and `passthrough()` on the strict
          // schema, so switching the prompt does not break legacy callers.
          system: buildSystemPromptWithReferences(locale, referenceMetrics),
          user: userPrompt,
          temperature: 0.3,
          maxTokens: 1500,
          // v1.21.5 — wider upstream budget so the reasoning-heavy briefing
          // generation is not aborted at the client's 60 s default on large
          // accounts (which returned an empty briefing + trend narrative).
          // v1.25 — honours the per-user response-timeout setting.
          timeoutMs: effectiveTimeoutMs,
          // The reply is parsed with `JSON.parse` below, so opt the OpenAI /
          // Codex chains into their strict JSON mode (gated on this flag).
          responseFormat: "json",
        }),
      });
      result = fallback.result;
      workingProviderType = fallback.workingProvider.providerType;
      fallbackHopCount = fallback.fallbackHops.length;
    } catch (e) {
      // v1.25 — record a dated failure marker (no cache row is written on this
      // path, so the last good briefing stays intact). The read path pairs the
      // preserved text with a discreet "couldn't refresh" hint, or shows a
      // retry empty state when there is no last good text.
      void recordBriefingFailure({
        userId,
        reason:
          e instanceof AllProvidersFailedError
            ? "all-providers-failed"
            : "provider-error",
        locale,
      });
      if (e instanceof AllProvidersFailedError) {
        annotate({
          meta: {
            insights_chain_outcome: "all-failed",
            insights_chain_attempts: e.attempts.length,
            insights_chain_first_provider: e.attempts[0]?.providerType ?? null,
            insights_chain_first_status: e.attempts[0]?.httpStatus ?? null,
          },
        });
        // Pick the most specific user-facing message we can. Auth-class
        // failures across the entire chain mean every provider's
        // credential is bad — keep the v1.4.5 "check your API key"
        // wording so the user knows where to act. 429 across the chain
        // is rate-limit; 5xx is upstream brown-out; transport-only
        // (ECONNRESET, no httpStatus) maps to the generic connection
        // hint so users on flaky networks don't see "rate-limited".
        const allAuth = e.attempts.every(
          (a) => a.httpStatus === 401 || a.httpStatus === 403,
        );
        if (allAuth) {
          return apiError(
            "AI provider rejected the request — check your API key in Settings > AI",
            422,
          );
        }
        const all429 = e.attempts.every((a) => a.httpStatus === 429);
        if (all429) {
          return apiError("AI provider rate-limited the request", 429);
        }
        const has5xx = e.attempts.some(
          (a) => a.httpStatus !== null && a.httpStatus >= 500,
        );
        if (has5xx) {
          return apiError(
            "AI provider temporarily unavailable, try again in a moment",
            503,
          );
        }
        const allTransport = e.attempts.every(
          (a) => a.httpStatus === null || a.httpStatus <= 0,
        );
        if (allTransport) {
          return apiError(
            "AI provider connection failed — check your AI settings",
            422,
          );
        }
        return apiError(
          "AI provider temporarily unavailable, try again in a moment",
          503,
        );
      }
      // v1.4.6 T5 mapped only the parse-error branch from 502→422. Non-
      // hard provider errors (e.g. a custom 4xx from a self-hosted local
      // model) still propagate here. Cloudflare rewrites 5xx to its own
      // HTML error page, which breaks `await res.json()` on the
      // dashboard. Mirror the v1.4.5 ai/test categorisation.
      const err = e as Error & { httpStatus?: number; bodyExcerpt?: string };
      annotate({
        meta: {
          insights_provider_error: err.message.slice(0, 500),
          insights_provider_status: err.httpStatus ?? null,
          insights_provider_body_excerpt:
            err.bodyExcerpt?.slice(0, 500) ?? null,
        },
      });
      const status = err.httpStatus ?? 0;
      if (status === 401 || status === 403) {
        return apiError(
          "AI provider rejected the request — check your API key in Settings > AI",
          422,
        );
      }
      if (status === 429) {
        return apiError("AI provider rate-limited the request", 429);
      }
      if (status >= 500) {
        return apiError(
          "AI provider temporarily unavailable, try again in a moment",
          503,
        );
      }
      return apiError(
        "AI provider connection failed — check your AI settings",
        422,
      );
    }

    let insights: InsightResult | Record<string, unknown>;
    try {
      const parsed = JSON.parse(result.content);
      // Try new schema first, fall back to raw parsed if validation fails
      const validated = insightResultSchema.safeParse(parsed);
      insights = validated.success ? validated.data : parsed;
    } catch {
      // Returning 502 here triggers Cloudflare's HTML error rewrite, which
      // breaks `await res.json()` on the client side. 422 stays passthrough
      // so the React Query mutation can read the JSON body and surface a
      // readable message. Same fix pattern as v1.4.5 ai/test.
      void recordBriefingFailure({ userId, reason: "invalid-json", locale });
      return apiError("AI response was not valid JSON", 422);
    }

    // v1.18.10 (HIGH-1) — daily-briefing number-grounding gate, mirroring the
    // recommendations citation cross-check next door. The schema only checks the
    // briefing's SHAPE; this asserts every number the briefing prose restates
    // traces to a `features.signalsOfDay` figure. On a miss: one corrective
    // retry, then drop the briefing block rather than ship a fabricated number.
    {
      const signals = features.signalsOfDay ?? null;
      let ungrounded = findUngroundedBriefingNumbers(
        readBriefingBlock(insights),
        signals,
        features,
      );
      if (ungrounded.length > 0) {
        annotate({
          action: { name: "insights.generate.briefing_grounding_retry" },
          meta: { ungroundedCount: ungrounded.length },
        });
        try {
          const retry = await runRawCompletionWithFallback({
            userId,
            providers: chain,
            params: singleUserTurn({
              system: buildSystemPromptWithReferences(locale, referenceMetrics),
              user: `${userPrompt}\n\n${buildBriefingGroundingCorrection(ungrounded)}`,
              temperature: 0.3,
              maxTokens: 1500,
              // v1.21.5 — wider upstream budget; see the first generation call.
              // v1.25 — honours the per-user response-timeout setting.
              timeoutMs: effectiveTimeoutMs,
              // Parsed with `JSON.parse` below — opt OpenAI / Codex into JSON mode.
              responseFormat: "json",
            }),
          });
          const parsedRetry = JSON.parse(retry.result.content);
          const validatedRetry = insightResultSchema.safeParse(parsedRetry);
          const retryInsights = validatedRetry.success
            ? validatedRetry.data
            : parsedRetry;
          ungrounded = findUngroundedBriefingNumbers(
            readBriefingBlock(retryInsights),
            signals,
            features,
          );
          if (ungrounded.length === 0) {
            insights = retryInsights;
            result = retry.result;
            workingProviderType = retry.workingProvider.providerType;
          }
        } catch {
          // Retry failed to produce parseable JSON — fall through to the strip.
        }
      }
      // Still ungrounded after the retry: strip the briefing rather than ship a
      // fabricated figure. The structured recommendations/citations stay.
      if (ungrounded.length > 0 && insights && typeof insights === "object") {
        (insights as Record<string, unknown>).dailyBriefing = null;
        annotate({
          action: { name: "insights.generate.briefing_grounding_stripped" },
          meta: { ungroundedCount: ungrounded.length },
        });
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        insightsCachedAt: new Date(),
        insightsCachedText: JSON.stringify(insights),
        // v1.16.8 — store the snapshot fingerprint so the nightly / forced
        // regeneration paths can detect "nothing changed" and skip the
        // provider call. The user-initiated POST itself stays un-gated: an
        // explicit regenerate request is honoured even on unchanged data
        // (it is already bounded by the hourly rate limit above). The
        // composite shape MUST match the gate in `comprehensive-generate.ts`,
        // or every off-request warm after a manual regenerate re-pays a
        // full generation on unchanged data. Beyond the features, three
        // prompt inputs that can change with NO data change join in:
        //   - aboutMe (Coach remember / Settings → AI edit),
        //   - comparisonBaseline (the comparison toggle adds/removes the
        //     prior-period context block; `null` snapshot means "none"),
        //   - generationLocale (the language the cached text renders in —
        //     hashing it makes a locale switch regenerate exactly once, so
        //     the briefing follows the reader; named `generationLocale`
        //     because the canonicaliser strips `locale` keys as volatile).
        insightsSnapshotHash: hashInsightSnapshot({
          features: compactFeatures,
          aboutMe: aboutMe ?? null,
          comparisonBaseline: comparisonSnapshot?.baseline ?? "none",
          generationLocale: locale,
        }),
      },
    });

    // v1.16.8 — no blanket per-status eviction here any more (nuking ~45
    // cache rows per manual regenerate deleted every hash baseline and was
    // the source of the post-regenerate card-regeneration storm). Instead,
    // the manual regenerate takes the cards along through the hash-gated
    // queue: every scope the user has data for is enqueued, the worker
    // forces each generator past its same-day cache read, and the content-
    // hash gate regenerates exactly the cards whose data changed while
    // refreshing the unchanged ones for free. This is the user's escape
    // hatch for a card they can SEE is stale — without it the cards had no
    // refresh path until the next nightly warm.
    const refillScopes = await enqueueStatusRefillForUser(
      userId,
      locale === "de" ? "de" : "en",
    );
    annotate({
      action: { name: "insights.generate.cards_refill" },
      meta: { scopes: refillScopes },
    });

    // v1.7.0 W6 — the dashboard snapshot embeds the pre-generated daily
    // briefing read-only; drop it so the next snapshot carries the fresh
    // briefing instead of the stale one.
    invalidateUserInsights(userId);

    await auditLog("insights.generate", {
      userId,
      ipAddress: getClientIp(request),
      details: {
        privacyMode: dbUser?.insightsPrivacyMode,
        tokensUsed: result.tokensUsed,
        providerType: result.providerType,
        chainProviderType: workingProviderType,
        fallbackHopCount,
        model: result.model,
      },
    });

    annotate({
      action: { name: "insights.generate" },
      meta: {
        cached: false,
        providerType: result.providerType,
        chainProviderType: workingProviderType,
        fallbackHopCount,
        model: result.model,
        tokensUsed: result.tokensUsed,
      },
    });

    return apiSuccess({ insights, cached: false, legacyPayload: false });
  }),
);
