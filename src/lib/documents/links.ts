/**
 * Document ⇄ condition link helpers shared by the vault routes.
 *
 * One grouped query per page (no N+1), owner-scoped everywhere: every episode
 * id a client sends is re-narrowed against the caller's live episodes before
 * it can land in `document_condition_links`.
 */
import { prisma } from "@/lib/db";
import type { DocumentConditionLinkDto } from "@/lib/validations/inbound-documents";

/**
 * Load the condition links for a page of documents in ONE grouped query.
 * Returns a map documentId → link DTOs (documents without links are absent).
 */
export async function loadConditionLinks(
  userId: string,
  documentIds: string[],
): Promise<Map<string, DocumentConditionLinkDto[]>> {
  const map = new Map<string, DocumentConditionLinkDto[]>();
  if (documentIds.length === 0) return map;
  const links = await prisma.documentConditionLink.findMany({
    where: { userId, documentId: { in: documentIds } },
    select: {
      documentId: true,
      episodeId: true,
      episode: { select: { label: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  for (const link of links) {
    const entry = map.get(link.documentId) ?? [];
    entry.push({ episodeId: link.episodeId, name: link.episode.label });
    map.set(link.documentId, entry);
  }
  return map;
}

/**
 * Narrow a client-sent episode-id list to the caller's LIVE episodes.
 * Returns the deduplicated owned ids, or null when any id is unknown /
 * foreign / deleted — the caller answers with a 404-shaped refusal (an
 * attacker probing another user's episode ids learns nothing beyond
 * "not found").
 */
export async function narrowOwnedEpisodeIds(
  userId: string,
  episodeIds: string[],
): Promise<string[] | null> {
  const unique = [...new Set(episodeIds)];
  if (unique.length === 0) return [];
  const owned = await prisma.illnessEpisode.findMany({
    where: { id: { in: unique }, userId, deletedAt: null },
    select: { id: true },
  });
  if (owned.length !== unique.length) return null;
  return unique;
}

/**
 * Replace-set a document's condition links inside the given transaction-ish
 * client: delete links no longer in the set, insert the missing ones.
 * `episodeIds` MUST already be owner-narrowed (`narrowOwnedEpisodeIds`).
 */
export async function replaceConditionLinks(
  tx: Pick<typeof prisma, "documentConditionLink">,
  userId: string,
  documentId: string,
  episodeIds: string[],
): Promise<void> {
  await tx.documentConditionLink.deleteMany({
    where: { userId, documentId, episodeId: { notIn: episodeIds } },
  });
  if (episodeIds.length > 0) {
    await tx.documentConditionLink.createMany({
      data: episodeIds.map((episodeId) => ({
        documentId,
        episodeId,
        userId,
      })),
      skipDuplicates: true,
    });
  }
}
