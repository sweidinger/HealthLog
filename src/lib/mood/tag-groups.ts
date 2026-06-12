import { prisma } from "@/lib/db";

/**
 * v1.17.0 — group resolution for the custom-tag write paths.
 *
 * A `categoryKey` on the wire is either a seeded category slug
 * (`feelings`, `custom`, …) or the caller's own `customcat:<uuid>` group
 * key. Resolution is owner-scoped by construction: another user's group —
 * or an inactive / unknown key — resolves to null, which the handlers
 * surface as a 422. This is the structural guard that keeps a custom tag's
 * `categoryId` pointing only at shared reference data or the owner's own
 * groups (and is what makes group deletion's re-home step sufficient).
 */
export async function resolveCategoryKeyForUser(
  categoryKey: string,
  userId: string,
): Promise<string | null> {
  const category = await prisma.moodTagCategory.findFirst({
    where: {
      key: categoryKey,
      isActive: true,
      OR: [{ userId: null }, { userId }],
    },
    select: { id: true },
  });
  return category?.id ?? null;
}
