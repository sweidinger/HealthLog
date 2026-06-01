import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * v1.8.5 — structured mood-tag taxonomy catalog.
 *
 * Returns the active Category -> Tag tree the mood-logging form renders
 * as a pick-from-catalog capture surface. Global reference data (one
 * shared catalog for the deployment, seeded by migration 0101), so the
 * read carries no per-user filter and no encryption. The `labelKey`
 * fields resolve client-side against the active locale.
 */
export const GET = apiHandler(async () => {
  // Auth-gated like every app route — the catalog is not public, but it
  // is identical for every authenticated user.
  await requireAuth();

  const categories = await prisma.moodTagCategory.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
    select: {
      key: true,
      labelKey: true,
      icon: true,
      tags: {
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        select: { key: true, labelKey: true, icon: true },
      },
    },
  });

  annotate({
    action: { name: "mood.tags.catalog.read" },
    meta: { category_count: categories.length },
  });

  return apiSuccess({ categories });
});
