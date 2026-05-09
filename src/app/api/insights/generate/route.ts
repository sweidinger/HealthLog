import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { extractFeatures } from "@/lib/insights/features";
import {
  getInsightsSystemPrompt,
  buildUserPrompt,
} from "@/lib/insights/prompt";
import { insightResultSchema, type InsightResult } from "@/lib/ai/types";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import {
  AllProvidersFailedError,
  runRawCompletionWithFallback,
} from "@/lib/ai/provider-runner";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

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
 * Per-status insight cache rows live in `audit_logs` keyed by
 * `action = "insights.{scope}-status.{locale}"` (see
 * `src/lib/insights/memory.ts` for the canonical scope list and
 * `src/lib/insights/{general,blood-pressure,weight,pulse,bmi,
 * mood,medication-compliance}-status.ts` for the writers). Each scope
 * has its own per-day eviction, so before v1.4.16 a force-regeneration
 * of the comprehensive insight would leave yesterday's per-status
 * cards visible on the insights page until the next calendar day
 * flipped. Drop them here so the next status fetch has to call the
 * LLM again with the same fresh feature set the comprehensive blob
 * just used.
 */
async function evictPerStatusInsightCache(userId: string): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      userId,
      action: { startsWith: "insights." },
      // Keep the `insights.generate` row this request just wrote and
      // the `insights.settings.*` rows — only the per-status cache
      // entries (`insights.<scope>-status.<locale>`) carry stale text.
      AND: [{ action: { contains: "-status." } }],
    },
  });
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const userId = user.id;

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
      locale: true,
    },
  });

  const locale = await resolveServerLocale({
    request,
    userLocale: dbUser?.locale ?? user.locale ?? null,
  });

  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  if (
    !forceRefresh &&
    dbUser?.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText);
      annotate({
        action: { name: "insights.generate" },
        meta: { cached: true },
      });
      return apiSuccess({
        insights: cached,
        cached: true,
        cachedAt: dbUser.insightsCachedAt,
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
  const rl = await checkRateLimit(`insights:${userId}`, limit, 60 * 60 * 1000);
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

  const includeRaw = dbUser?.insightsPrivacyMode === "raw";
  const features = await extractFeatures(userId, includeRaw);
  const featuresJson = JSON.stringify(features, null, 2);
  const userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
  );

  let result;
  let workingProviderType: string;
  let fallbackHopCount = 0;
  try {
    const fallback = await runRawCompletionWithFallback({
      userId,
      providers: chain,
      params: {
        systemPrompt: getInsightsSystemPrompt(locale),
        userPrompt,
        temperature: 0.3,
        maxTokens: 1500,
      },
    });
    result = fallback.result;
    workingProviderType = fallback.workingProvider.providerType;
    fallbackHopCount = fallback.fallbackHops.length;
  } catch (e) {
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
        insights_provider_body_excerpt: err.bodyExcerpt?.slice(0, 500) ?? null,
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
    return apiError("AI response was not valid JSON", 422);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
    },
  });

  // v1.4.16 A7: a fresh comprehensive insight always supersedes the
  // per-status cache. Otherwise the dashboard re-paints itself with the
  // newly generated comprehensive while the insights-page status cards
  // still show yesterday's text until midnight Berlin time.
  await evictPerStatusInsightCache(userId);

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

  return apiSuccess({ insights, cached: false });
});
