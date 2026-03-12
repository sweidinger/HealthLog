import { prisma } from "@/lib/db";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

/**
 * Get insights configuration status.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      openaiKeyEncrypted: true,
      insightsPrivacyMode: true,
      insightsCachedAt: true,
    },
  });

  annotate({ action: { name: "insights.settings.get" } });

  return apiSuccess({
    hasKey: !!dbUser?.openaiKeyEncrypted,
    privacyMode: dbUser?.insightsPrivacyMode ?? "aggregated",
    lastInsightAt: dbUser?.insightsCachedAt ?? null,
  });
});

/**
 * Update insights settings (API key and/or privacy mode).
 */
export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson<Record<string, unknown>>(request);

  if (jsonError) return jsonError;
  const data: Record<string, unknown> = {};

  // Update API key if provided
  if (typeof body.apiKey === "string") {
    const key = (body.apiKey as string).trim();
    if (key === "") {
      // Remove key
      data.openaiKeyEncrypted = null;
      data.insightsCachedAt = null;
      data.insightsCachedText = null;
    } else {
      if (!key.startsWith("sk-")) {
        return apiError(
          "Invalid API key format (must start with sk-)",
          422,
        );
      }
      data.openaiKeyEncrypted = encrypt(key);
    }
  }

  // Update privacy mode if provided
  if (typeof body.privacyMode === "string") {
    const mode = body.privacyMode as string;
    if (!["aggregated", "raw"].includes(mode)) {
      return apiError("Invalid privacy mode", 422);
    }
    data.insightsPrivacyMode = mode;
    // Clear cache when privacy mode changes
    data.insightsCachedAt = null;
    data.insightsCachedText = null;
  }

  if (Object.keys(data).length === 0) {
    return apiError("No changes", 422);
  }

  await prisma.user.update({
    where: { id: user.id },
    data,
  });

  annotate({ action: { name: "insights.settings.update" } });

  return apiSuccess({ updated: true });
});
