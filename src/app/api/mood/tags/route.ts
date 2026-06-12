import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { decryptCustomLabel } from "@/lib/mood/custom-tags";
import {
  parseStoredMoodTagLayout,
  resolveMoodTagPlacement,
} from "@/lib/mood/tag-layout";

export const dynamic = "force-dynamic";

/**
 * v1.8.5 / v1.13.0 / v1.17.0 — the EFFECTIVE per-user mood-tag taxonomy.
 *
 * Returns the fully-resolved, ordered Category → Tag tree the mood-logging
 * form renders as a pick-from-catalogue surface — for web AND iOS, in one
 * read. The catalogue is global reference data (seeded by migration);
 * layered per-user adjustments:
 *   - the user's own custom tags (`mood_tags.user_id = me`, `custom:` keys),
 *     label decrypted;
 *   - the user's own custom groups (`mood_tag_categories.user_id = me`,
 *     `customcat:` keys), label decrypted, `custom: true` on the DTO;
 *   - the per-user layout blob (`User.moodTagLayoutJson`): group display
 *     order + per-group tag placement. A CATALOGUE tag "moved" into a group
 *     is placement only — its `categoryId` never changes, and entry writes
 *     are key-based, so no grouping change can break `tagKeys` /
 *     `ratedFactors` ingestion;
 *   - catalogue tags the user hid (`mood_tag_hidden`) are omitted — unless
 *     `include` contains `hidden`, in which case they return `hidden: true`.
 *
 * `?include=` is a comma list (v1.17.0; the bare v1.13 `hidden` still
 * works): `hidden` (hidden catalogue tags), `archived` (the user's own
 * inactive custom tags, `archived: true`), `usage` (per-tag `usageCount`
 * over the user's live entries — management read only). When any flag is
 * set the user's own EMPTY groups are kept (the management screen needs
 * them); the plain picker read keeps dropping empty categories.
 *
 * Every tag carries `custom: boolean` + `label: string | null`: render
 * `label` for a custom tag, resolve `labelKey` against the locale for a
 * catalogue tag. Backward-compatible — a v1.13 client ignoring the new
 * fields sees the same tree, now per-user ordered.
 */
export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const includeFlags = new Set(
    (request.nextUrl.searchParams.get("include") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const includeHidden = includeFlags.has("hidden");
  const includeArchived = includeFlags.has("archived");
  const includeUsage = includeFlags.has("usage");
  const managementRead = includeFlags.size > 0;

  const [categories, tags, hiddenRows, layoutRow, usageRows] =
    await Promise.all([
      // Seeded categories + this user's own custom groups.
      prisma.moodTagCategory.findMany({
        where: { isActive: true, OR: [{ userId: null }, { userId: user.id }] },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          key: true,
          labelKey: true,
          icon: true,
          userId: true,
          labelEncrypted: true,
        },
      }),
      // Catalogue tags (user_id NULL) + this user's own custom tags. Another
      // user's customs are excluded by construction. `archived` lifts the
      // isActive pin for the user's OWN rows only — retired catalogue tags
      // (0126 precedent) never resurface.
      prisma.moodTag.findMany({
        where: includeArchived
          ? { OR: [{ userId: null, isActive: true }, { userId: user.id }] }
          : { isActive: true, OR: [{ userId: null }, { userId: user.id }] },
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
          isActive: true,
          userId: true,
          labelEncrypted: true,
        },
      }),
      prisma.moodTagHidden.findMany({
        where: { userId: user.id },
        select: { moodTagId: true },
      }),
      prisma.user.findUnique({
        where: { id: user.id },
        select: { moodTagLayoutJson: true },
      }),
      includeUsage
        ? prisma.moodEntryTagLink.groupBy({
            by: ["moodTagId"],
            _count: { _all: true },
            where: { moodEntry: { userId: user.id, deletedAt: null } },
          })
        : Promise.resolve(
            [] as Array<{ moodTagId: string; _count: { _all: number } }>,
          ),
    ]);

  const hiddenIds = new Set(hiddenRows.map((r) => r.moodTagId));
  const usageByTagId = new Map(
    usageRows.map((r) => [r.moodTagId, r._count._all]),
  );
  const categoryKeyById = new Map(categories.map((c) => [c.id, c.key]));

  // Visible tag rows (global sortOrder preserved by the query).
  const visibleTags = tags.filter((t) => {
    const isCustom = t.userId !== null;
    const isHidden = !isCustom && hiddenIds.has(t.id);
    if (isHidden && !includeHidden) return false;
    return categoryKeyById.has(t.categoryId);
  });

  const layout = parseStoredMoodTagLayout(layoutRow?.moodTagLayoutJson);
  const { orderedCategoryKeys, tagKeysByCategory } = resolveMoodTagPlacement({
    categoryKeysInSeededOrder: categories.map((c) => c.key),
    tags: visibleTags.map((t) => ({
      key: t.key,
      homeCategoryKey: categoryKeyById.get(t.categoryId) as string,
    })),
    layout,
  });

  const tagByKey = new Map(visibleTags.map((t) => [t.key, t]));
  const categoryByKey = new Map(categories.map((c) => [c.key, c]));

  const responseCategories = orderedCategoryKeys
    .map((categoryKey) => {
      const c = categoryByKey.get(categoryKey);
      if (!c) return null;
      const isCustomCategory = c.userId !== null;
      const catTags = (tagKeysByCategory.get(categoryKey) ?? [])
        .map((tagKey) => tagByKey.get(tagKey))
        .filter((t) => t !== undefined)
        .map((t) => {
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
            ...(includeArchived && isCustom
              ? { archived: !t.isActive }
              : {}),
            ...(includeUsage
              ? { usageCount: usageByTagId.get(t.id) ?? 0 }
              : {}),
          };
        });
      return {
        key: c.key,
        labelKey: isCustomCategory ? null : c.labelKey,
        label: isCustomCategory ? decryptCustomLabel(c.labelEncrypted) : null,
        icon: c.icon,
        custom: isCustomCategory,
        tags: catTags,
      };
    })
    .filter((c) => c !== null)
    // Drop a category with no visible tags (e.g. `custom` for a user with
    // none yet) so the picker grid stays tight — EXCEPT the user's own
    // groups on a management read, which must surface even when empty.
    .filter((c) => c.tags.length > 0 || (managementRead && c.custom));

  annotate({
    action: { name: "mood.tags.catalog.read" },
    meta: {
      category_count: responseCategories.length,
      include_hidden: includeHidden,
      include_archived: includeArchived,
      include_usage: includeUsage,
    },
  });

  return apiSuccess({ categories: responseCategories });
});
