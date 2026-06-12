import { NextRequest } from "next/server";

import { prisma, toJson } from "@/lib/db";
import {
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  moodTagLayoutSchema,
  parseStoredMoodTagLayout,
  mergeMoodTagLayout,
  resolveGroupOrder,
  type MoodTagLayout,
} from "@/lib/mood/tag-layout";

export const dynamic = "force-dynamic";

/**
 * v1.17.0 — per-user mood-tag layout (group order + tag placements).
 *
 * GET returns the stored blob merged over defaults: `groupOrder` fully
 * resolved against the user's effective category set (layout order first,
 * unmentioned categories appended in seeded order) + the raw `placements`.
 * PUT updates with preserve-when-absent semantics — a groupOrder-only PUT
 * keeps the stored placements and vice versa. Mirrors
 * `/api/medications/layout`; the blob lives on its own `User` column
 * (`mood_tag_layout_json`) per the per-surface-column convention.
 *
 * Display-only: keys here are opaque, unknown / stale keys are dropped at
 * read time by `GET /api/mood/tags`, so the schema bounds size and shape
 * but does not assert ownership of every key.
 */

async function resolveLayoutResponse(
  userId: string,
  layout: MoodTagLayout,
): Promise<{
  groupOrder: string[];
  placements: Record<string, string[]>;
}> {
  const categories = await prisma.moodTagCategory.findMany({
    where: { isActive: true, OR: [{ userId: null }, { userId }] },
    orderBy: { sortOrder: "asc" },
    select: { key: true },
  });
  return {
    groupOrder: resolveGroupOrder(
      categories.map((c) => c.key),
      layout.groupOrder,
    ),
    placements: layout.placements ?? {},
  };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { moodTagLayoutJson: true },
  });
  const stored = parseStoredMoodTagLayout(row?.moodTagLayoutJson);
  return apiSuccess(await resolveLayoutResponse(user.id, stored));
});

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: rawJsonBody, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = moodTagLayoutSchema.safeParse(rawJsonBody);
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  // Preserve-when-absent: a PUT carrying only `groupOrder` must not wipe
  // the stored placements, and a placements-only PUT must not reset the
  // group order.
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { moodTagLayoutJson: true },
  });
  const stored = parseStoredMoodTagLayout(row?.moodTagLayoutJson);
  const merged: MoodTagLayout = mergeMoodTagLayout(stored, {
    ...(parsed.data.groupOrder !== undefined
      ? { groupOrder: parsed.data.groupOrder }
      : {}),
    ...(parsed.data.placements !== undefined
      ? { placements: parsed.data.placements }
      : {}),
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { moodTagLayoutJson: toJson(merged) },
  });

  annotate({
    action: { name: "mood.tag.layout.update" },
    meta: {
      group_order_count: merged.groupOrder?.length ?? 0,
      placement_group_count: Object.keys(merged.placements ?? {}).length,
    },
  });

  return apiSuccess(await resolveLayoutResponse(user.id, merged));
});
