import { prisma } from "@/lib/db";

/**
 * v1.8.5 — structured-tag link helpers.
 *
 * Resolve a list of catalog tag keys (`mood_tags.key`) to their ids and
 * write the `mood_entry_tag_links` join for a mood entry. The catalog is
 * the source of truth: unknown keys are dropped silently so a stale
 * client can never mint a link to a tag the deployment doesn't carry.
 */

/**
 * Resolve catalog tag keys to ids, dropping unknown / inactive keys.
 * Returns the ids in catalog order (deduped).
 */
export async function resolveTagKeysToIds(keys: string[]): Promise<string[]> {
  const unique = Array.from(new Set(keys));
  if (unique.length === 0) return [];
  const rows = await prisma.moodTag.findMany({
    where: { key: { in: unique }, isActive: true },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Create the structured-tag links for a freshly-created entry. No-op on
 * an empty / all-unknown key set.
 */
export async function createTagLinks(
  moodEntryId: string,
  keys: string[],
): Promise<void> {
  const tagIds = await resolveTagKeysToIds(keys);
  if (tagIds.length === 0) return;
  await prisma.moodEntryTagLink.createMany({
    data: tagIds.map((moodTagId) => ({ moodEntryId, moodTagId })),
    skipDuplicates: true,
  });
}

/**
 * Replace the full structured-tag link set for an entry. `keys` is the
 * desired set; the helper deletes links no longer present and inserts
 * the new ones, leaving unchanged links in place. Passing an empty array
 * clears every link.
 */
export async function replaceTagLinks(
  moodEntryId: string,
  keys: string[],
): Promise<void> {
  const desiredIds = new Set(await resolveTagKeysToIds(keys));
  const existing = await prisma.moodEntryTagLink.findMany({
    where: { moodEntryId },
    select: { moodTagId: true },
  });
  const existingIds = new Set(existing.map((row) => row.moodTagId));

  const toDelete = [...existingIds].filter((id) => !desiredIds.has(id));
  const toCreate = [...desiredIds].filter((id) => !existingIds.has(id));

  if (toDelete.length > 0) {
    await prisma.moodEntryTagLink.deleteMany({
      where: { moodEntryId, moodTagId: { in: toDelete } },
    });
  }
  if (toCreate.length > 0) {
    await prisma.moodEntryTagLink.createMany({
      data: toCreate.map((moodTagId) => ({ moodEntryId, moodTagId })),
      skipDuplicates: true,
    });
  }
}
