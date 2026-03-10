import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import {
  updateMoodEntrySchema,
  getScoreForMood,
} from "@/lib/validations/moodlog";
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

type RouteParams = { params: Promise<{ id: string }> };

function toBerlinDate(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
  }).format(date);
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    return JSON.parse(tags) as string[];
  } catch {
    return [];
  }
}

export const GET = apiHandler(async (_request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const entry = await prisma.moodEntry.findUnique({ where: { id } });

  if (!entry || entry.userId !== user.id) {
    return apiError("Stimmungseintrag nicht gefunden", 404);
  }

  annotate({ action: { name: "mood-entries.get" }, meta: { moodEntryId: id } });

  return apiSuccess({ ...entry, tags: parseTags(entry.tags) });
});

export const PUT = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const existing = await prisma.moodEntry.findUnique({ where: { id } });

  if (!existing || existing.userId !== user.id) {
    return apiError("Stimmungseintrag nicht gefunden", 404);
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const parsed = updateMoodEntrySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const data = parsed.data;

  const updateData: Record<string, unknown> = {};
  if (data.mood !== undefined) {
    updateData.mood = data.mood;
    updateData.score = getScoreForMood(data.mood);
  }
  if (data.moodLoggedAt !== undefined) {
    updateData.moodLoggedAt = data.moodLoggedAt;
    updateData.date = toBerlinDate(data.moodLoggedAt);
  }
  if (data.tags !== undefined) {
    updateData.tags = data.tags ? JSON.stringify(data.tags) : null;
  }

  const entry = await prisma.moodEntry.update({
    where: { id },
    data: updateData,
  });

  await auditLog("moodEntry.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { moodEntryId: id },
  });

  annotate({ action: { name: "mood-entries.update" }, meta: { moodEntryId: id } });

  return apiSuccess({ ...entry, tags: parseTags(entry.tags) });
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAuth();

  const { id } = await params;

  const existing = await prisma.moodEntry.findUnique({ where: { id } });

  if (!existing || existing.userId !== user.id) {
    return apiError("Stimmungseintrag nicht gefunden", 404);
  }

  await prisma.moodEntry.delete({ where: { id } });

  await auditLog("moodEntry.delete", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { moodEntryId: id, mood: existing.mood },
  });

  annotate({ action: { name: "mood-entries.delete" }, meta: { moodEntryId: id } });

  return apiSuccess({ deleted: true });
});
