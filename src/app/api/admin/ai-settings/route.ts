import { NextRequest } from "next/server";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp, safeJson } from "@/lib/api-response";
import { encrypt } from "@/lib/crypto";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.ai-settings.get" } });

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  const hasKey = Boolean(settings?.adminAiKeyEncrypted);
  const model = settings?.adminAiModel ?? "gpt-4o-mini";
  const baseUrl = settings?.adminAiBaseUrl ?? "https://api.openai.com/v1";

  return apiSuccess({
    hasKey,
    keyPreview: hasKey && settings?.adminAiKeyEncrypted
      ? `${settings.adminAiKeyEncrypted.slice(0, 7)}...`
      : null,
    model,
    baseUrl,
  });
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.ai-settings.update" } });

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const { apiKey, model, baseUrl } = body as {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };

  const updates: Record<string, unknown> = {};
  const auditDetails: Record<string, unknown> = {};

  if (apiKey !== undefined) {
    const trimmed = apiKey.trim();
    if (trimmed) {
      updates.adminAiKeyEncrypted = encrypt(trimmed);
      auditDetails.apiKeyUpdated = true;
    } else {
      updates.adminAiKeyEncrypted = null;
      auditDetails.apiKeyUpdated = false;
    }
  }

  if (model !== undefined) {
    const trimmed = model.trim();
    if (!trimmed) throw new HttpError(422, "Model cannot be empty");
    updates.adminAiModel = trimmed;
    auditDetails.model = trimmed;
  }

  if (baseUrl !== undefined) {
    const trimmed = baseUrl.trim();
    if (!trimmed) throw new HttpError(422, "Base URL cannot be empty");
    if (!trimmed.startsWith("https://")) {
      throw new HttpError(422, "Base URL must start with https://");
    }
    updates.adminAiBaseUrl = trimmed;
    auditDetails.baseUrl = trimmed;
  }

  if (Object.keys(updates).length === 0) {
    throw new HttpError(422, "No valid fields");
  }

  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: updates,
    create: { id: "singleton", ...updates },
  });

  await auditLog("admin.ai-settings.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: auditDetails,
  });

  const hasKey = Boolean(settings.adminAiKeyEncrypted);

  return apiSuccess({
    hasKey,
    keyPreview: hasKey && settings.adminAiKeyEncrypted
      ? `${settings.adminAiKeyEncrypted.slice(0, 7)}...`
      : null,
    model: settings.adminAiModel,
    baseUrl: settings.adminAiBaseUrl,
  });
});
