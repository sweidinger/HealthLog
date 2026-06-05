import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  createCustomTagSchema,
  mintCustomTagKey,
  encryptCustomLabel,
  CUSTOM_CATEGORY_ID,
  MAX_CUSTOM_TAGS_PER_USER,
} from "@/lib/mood/custom-tags";

export const dynamic = "force-dynamic";

/**
 * v1.13.0 — create a per-user custom mood tag.
 *
 * `POST /api/mood/tags/custom` — body `{ label, icon?, categoryKey? }`. Mints
 * a `custom:<uuid>` key, encrypts the label at rest, and stores a BINARY tag
 * under the global `custom` category owned by the caller. Capped per user.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = createCustomTagSchema.safeParse(await request.json());
  if (!parsed.success) return returnAllZodIssues(parsed.error, 422);

  const activeCount = await prisma.moodTag.count({
    where: { userId: user.id, isActive: true },
  });
  if (activeCount >= MAX_CUSTOM_TAGS_PER_USER) {
    return apiError(
      `Custom tag limit reached (${MAX_CUSTOM_TAGS_PER_USER})`,
      422,
    );
  }

  const key = mintCustomTagKey();
  const created = await prisma.moodTag.create({
    data: {
      categoryId: CUSTOM_CATEGORY_ID,
      key,
      // Catalogue rows resolve `labelKey` against the locale; a custom tag
      // renders its decrypted `label` instead, so labelKey just mirrors the
      // key for a stable, non-empty value.
      labelKey: key,
      labelEncrypted: encryptCustomLabel(parsed.data.label),
      icon: parsed.data.icon ?? null,
      kind: "BINARY",
      sortOrder: activeCount,
      userId: user.id,
    },
    select: { key: true, icon: true, kind: true, scaleMin: true, scaleMax: true, inverse: true },
  });

  annotate({ action: { name: "mood.tag.custom.create" }, meta: { icon: created.icon } });

  return apiSuccess(
    {
      key: created.key,
      labelKey: null,
      label: parsed.data.label,
      icon: created.icon,
      kind: created.kind,
      scaleMin: created.scaleMin,
      scaleMax: created.scaleMax,
      inverse: created.inverse,
      custom: true,
    },
    201,
  );
});
