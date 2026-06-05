import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  updateCustomTagSchema,
  encryptCustomLabel,
  decryptCustomLabel,
  isCustomTagKey,
} from "@/lib/mood/custom-tags";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ key: string }> };

/**
 * v1.13.0 — update / delete a per-user custom mood tag.
 *
 * Both handlers resolve the `custom:`-prefixed key against the CALLER's own
 * rows only — another user's key (or a catalogue key) is a 404, so a tag can
 * never be edited or removed across the ownership boundary.
 */

/** `PATCH /api/mood/tags/custom/:key` — rename / recolour / (de)activate. */
export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (!isCustomTagKey(key)) return apiError("Not a custom tag", 404);

    const parsed = updateCustomTagSchema.safeParse(await request.json());
    if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

    const owned = await prisma.moodTag.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom tag not found", 404);

    const updated = await prisma.moodTag.update({
      where: { id: owned.id },
      data: {
        ...(parsed.data.label !== undefined
          ? { labelEncrypted: encryptCustomLabel(parsed.data.label) }
          : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
      },
      select: {
        key: true,
        icon: true,
        kind: true,
        scaleMin: true,
        scaleMax: true,
        inverse: true,
        isActive: true,
        labelEncrypted: true,
      },
    });

    annotate({ action: { name: "mood.tag.custom.update" } });

    return apiSuccess({
      key: updated.key,
      labelKey: null,
      label: decryptCustomLabel(updated.labelEncrypted),
      icon: updated.icon,
      kind: updated.kind,
      scaleMin: updated.scaleMin,
      scaleMax: updated.scaleMax,
      inverse: updated.inverse,
      isActive: updated.isActive,
      custom: true,
    });
  },
);

/**
 * `DELETE /api/mood/tags/custom/:key` — soft-deactivate by default (history
 * intact); `?purge=true` hard-deletes the row and cascades its entry links.
 */
export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { key } = await params;
    if (!isCustomTagKey(key)) return apiError("Not a custom tag", 404);

    const owned = await prisma.moodTag.findFirst({
      where: { key, userId: user.id },
      select: { id: true },
    });
    if (!owned) return apiError("Custom tag not found", 404);

    const purge = request.nextUrl.searchParams.get("purge") === "true";
    if (purge) {
      // FK cascade removes the `mood_entry_tag_links` rows too.
      await prisma.moodTag.delete({ where: { id: owned.id } });
    } else {
      await prisma.moodTag.update({
        where: { id: owned.id },
        data: { isActive: false },
      });
    }

    annotate({ action: { name: "mood.tag.custom.delete" }, meta: { purge } });

    return apiSuccess({ key, purged: purge });
  },
);
