import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { decryptCustomLabel } from "@/lib/mood/custom-tags";

export const dynamic = "force-dynamic";

/**
 * v1.8.5 / v1.13.0 — the EFFECTIVE per-user mood-tag taxonomy.
 *
 * Returns the active Category → Tag tree the mood-logging form renders as a
 * pick-from-catalogue surface. The catalogue is global reference data (seeded
 * by migration); v1.13.0 layers two per-user adjustments on top so the read
 * is now user-scoped:
 *   - the user's own custom tags (`mood_tags.user_id = me`, `custom:` keys)
 *     appear under the seeded `custom` category, their label decrypted;
 *   - catalogue tags the user hid (`mood_tag_hidden`) are omitted — unless
 *     `?include=hidden` is set, in which case they're returned with
 *     `hidden: true` so the management screen can toggle them back on.
 *
 * Every tag carries `custom: boolean` + `label: string | null`: render
 * `label` for a custom tag, resolve `labelKey` against the locale for a
 * catalogue tag. Backward-compatible — a client that ignores the new fields
 * just sees the same categories → tags shape.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  const includeHidden =
    request.nextUrl.searchParams.get("include") === "hidden";

  const [categories, tags, hiddenRows] = await Promise.all([
    prisma.moodTagCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { id: true, key: true, labelKey: true, icon: true },
    }),
    // Catalogue tags (user_id NULL) + this user's own custom tags. Another
    // user's customs are excluded by construction.
    prisma.moodTag.findMany({
      where: { isActive: true, OR: [{ userId: null }, { userId: user.id }] },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        categoryId: true,
        key: true,
        labelKey: true,
        icon: true,
        kind: true,
        scaleMin: true,
        scaleMax: true,
        inverse: true,
        userId: true,
        labelEncrypted: true,
      },
    }),
    prisma.moodTagHidden.findMany({
      where: { userId: user.id },
      select: { moodTagId: true },
    }),
  ]);

  const hiddenIds = new Set(hiddenRows.map((r) => r.moodTagId));

  const tagsByCategory = new Map<string, typeof tags>();
  for (const t of tags) {
    const isCustom = t.userId !== null;
    const isHidden = !isCustom && hiddenIds.has(t.id);
    if (isHidden && !includeHidden) continue;
    const list = tagsByCategory.get(t.categoryId) ?? [];
    list.push(t);
    tagsByCategory.set(t.categoryId, list);
  }

  const responseCategories = categories
    .map((c) => {
      const catTags = (tagsByCategory.get(c.id) ?? []).map((t) => {
        const isCustom = t.userId !== null;
        return {
          key: t.key,
          labelKey: isCustom ? null : t.labelKey,
          label: isCustom ? decryptCustomLabel(t.labelEncrypted) : null,
          icon: t.icon,
          kind: t.kind,
          scaleMin: t.scaleMin,
          scaleMax: t.scaleMax,
          inverse: t.inverse,
          custom: isCustom,
          ...(includeHidden && !isCustom
            ? { hidden: hiddenIds.has(t.id) }
            : {}),
        };
      });
      return {
        key: c.key,
        labelKey: c.labelKey,
        icon: c.icon,
        tags: catTags,
      };
    })
    // Drop a category with no visible tags (e.g. `custom` for a user with
    // none yet) so the picker grid stays tight.
    .filter((c) => c.tags.length > 0);

  annotate({
    action: { name: "mood.tags.catalog.read" },
    meta: {
      category_count: responseCategories.length,
      include_hidden: includeHidden,
    },
  });

  return apiSuccess({ categories: responseCategories });
});
