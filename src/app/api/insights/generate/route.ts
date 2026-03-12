import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { extractFeatures } from "@/lib/insights/features";
import {
  INSIGHTS_SYSTEM_PROMPT,
  buildUserPrompt,
  type InsightsOutput,
} from "@/lib/insights/prompt";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * Generate AI-powered health insights.
 * Rate limit: 2 per hour per user.
 * Caches result daily (or until new data arrives).
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const userId = user.id;

  // Rate limit: 2 per hour per user
  const rl = await checkRateLimit(`insights:${userId}`, 2, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError(
      "Maximum 2 insight generations per hour. Please try again later.",
      429,
    );
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      openaiKeyEncrypted: true,
      insightsPrivacyMode: true,
      insightsCachedAt: true,
      insightsCachedText: true,
    },
  });

  if (!dbUser?.openaiKeyEncrypted) {
    return apiError(
      "No OpenAI API key configured. Please set it in settings.",
      422,
    );
  }

  // Check if force refresh is requested
  const body = await request.json().catch(() => ({}));
  const forceRefresh = body.force === true;

  // Return cached result if available and less than 24h old
  if (
    !forceRefresh &&
    dbUser.insightsCachedAt &&
    dbUser.insightsCachedText &&
    Date.now() - dbUser.insightsCachedAt.getTime() < 24 * 60 * 60 * 1000
  ) {
    try {
      const cached = JSON.parse(dbUser.insightsCachedText) as InsightsOutput;
      annotate({ action: { name: "insights.generate" }, meta: { cached: true } });
      return apiSuccess({
        insights: cached,
        cached: true,
        cachedAt: dbUser.insightsCachedAt,
      });
    } catch {
      // Invalid cache, regenerate
    }
  }

  const apiKey = decrypt(dbUser.openaiKeyEncrypted);
  const includeRaw = dbUser.insightsPrivacyMode === "raw";
  const features = await extractFeatures(userId, includeRaw);
  const featuresJson = JSON.stringify(features, null, 2);
  const userPrompt = buildUserPrompt(featuresJson, dbUser.insightsPrivacyMode);

  // Call OpenAI
  const openaiRes = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: INSIGHTS_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1000,
        response_format: { type: "json_object" },
      }),
    },
  );

  if (!openaiRes.ok) {
    const errBody = await openaiRes.text();
    annotate({ meta: { openai_status: openaiRes.status, openai_error: errBody } });
    if (openaiRes.status === 401) {
      return apiError("Invalid OpenAI API key", 422);
    }
    return apiError("OpenAI request failed", 502);
  }

  const openaiJson = await openaiRes.json();
  const content = openaiJson.choices?.[0]?.message?.content;

  if (!content) {
    return apiError("No response from OpenAI", 502);
  }

  let insights: InsightsOutput;
  try {
    insights = JSON.parse(content);
  } catch {
    return apiError("Failed to parse OpenAI response", 502);
  }

  // Cache the result
  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: new Date(),
      insightsCachedText: JSON.stringify(insights),
    },
  });

  // Audit log (no sensitive content)
  await auditLog("insights.generate", {
    userId,
    ipAddress: getClientIp(request),
    details: {
      privacyMode: dbUser.insightsPrivacyMode,
      tokensUsed: openaiJson.usage?.total_tokens ?? null,
    },
  });

  annotate({
    action: { name: "insights.generate" },
    meta: {
      cached: false,
      privacyMode: dbUser.insightsPrivacyMode,
      tokensUsed: openaiJson.usage?.total_tokens ?? null,
    },
  });

  return apiSuccess({ insights, cached: false });
});
