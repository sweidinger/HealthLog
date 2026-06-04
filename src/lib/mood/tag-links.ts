import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * v1.8.5 — structured-tag link helpers.
 *
 * Resolve a list of catalog tag keys (`mood_tags.key`) to their ids and
 * write the `mood_entry_tag_links` join for a mood entry. The catalog is
 * the source of truth: unknown keys are dropped silently so a stale
 * client can never mint a link to a tag the deployment doesn't carry.
 *
 * Every helper accepts an optional `db` client so the caller can thread
 * the same `$transaction` client that wrote the entry — the entry row and
 * its links then commit (or roll back) together.
 */

/**
 * A Prisma client the helpers can run against: the singleton or a
 * `$transaction` interactive client.
 */
type TagLinkDb = PrismaClient | Prisma.TransactionClient;

/**
 * v1.12.0 — a rated factor as it arrives on the wire: a catalog
 * (`mood_tags.key`) + the user's score for this entry.
 */
export interface RatedFactorInput {
  key: string;
  rating: number;
}

/**
 * v1.12.0 — a rated factor resolved to its catalog row id, ready to
 * write onto the `mood_entry_tag_links` join.
 */
interface ResolvedRatedFactor {
  moodTagId: string;
  rating: number;
}

/**
 * v1.12.0 — thrown when a submitted factor rating falls outside the
 * resolved `MoodTag`'s own `scaleMin..scaleMax`. The route maps this to a
 * 422 (the per-tag scale is the real gate; the Zod schema only enforces
 * the outer 1..5 envelope). Unknown / non-RATED keys are NOT an error —
 * they are dropped silently, matching the binary `tagKeys` posture.
 */
export class RatedFactorOutOfRangeError extends Error {
  constructor(
    public readonly key: string,
    public readonly rating: number,
    public readonly scaleMin: number,
    public readonly scaleMax: number,
  ) {
    super(
      `Rating ${rating} for factor "${key}" is outside its scale ${scaleMin}..${scaleMax}`,
    );
    this.name = "RatedFactorOutOfRangeError";
  }
}

/**
 * Resolve rated-factor inputs against the catalog. Unknown keys, inactive
 * tags, and `kind = 'BINARY'` keys are dropped silently (the catalog is
 * the source of truth, same posture as `resolveTagKeysToIds`). A rating
 * outside the resolved tag's `scaleMin..scaleMax` throws
 * `RatedFactorOutOfRangeError` so the route returns 422. The last value
 * wins on a duplicate key in the same payload.
 */
export async function resolveRatedFactors(
  factors: RatedFactorInput[],
  db: TagLinkDb = prisma,
): Promise<ResolvedRatedFactor[]> {
  if (factors.length === 0) return [];
  // Last-writer-wins on a duplicate key in the same submission.
  const byKey = new Map<string, number>();
  for (const f of factors) byKey.set(f.key, f.rating);

  const rows = await db.moodTag.findMany({
    where: { key: { in: [...byKey.keys()] }, isActive: true, kind: "RATED" },
    select: { id: true, key: true, scaleMin: true, scaleMax: true },
  });

  const resolved: ResolvedRatedFactor[] = [];
  for (const row of rows) {
    const rating = byKey.get(row.key);
    if (rating === undefined) continue;
    if (rating < row.scaleMin || rating > row.scaleMax) {
      throw new RatedFactorOutOfRangeError(
        row.key,
        rating,
        row.scaleMin,
        row.scaleMax,
      );
    }
    resolved.push({ moodTagId: row.id, rating });
  }
  return resolved;
}

/**
 * Resolve catalog tag keys to ids, dropping unknown / inactive keys.
 * Returns the ids in catalog order (deduped).
 */
export async function resolveTagKeysToIds(
  keys: string[],
  db: TagLinkDb = prisma,
): Promise<string[]> {
  const unique = Array.from(new Set(keys));
  if (unique.length === 0) return [];
  const rows = await db.moodTag.findMany({
    where: { key: { in: unique }, isActive: true },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Create the structured-tag links for a freshly-created entry. No-op on
 * an empty / all-unknown key set.
 *
 * v1.12.0 — optionally also writes rated-factor links (`kind = 'RATED'`
 * catalog tags carrying a per-entry `rating`). Binary keys leave `rating`
 * NULL; rated factors persist their score. A factor key passed in both
 * `keys` and `ratedFactors` resolves to a single link carrying the
 * rating (the rated insert wins via `skipDuplicates`, which is why the
 * rated rows are written first). Throws `RatedFactorOutOfRangeError` (→
 * route 422) when a rating is out of the factor's scale.
 */
export async function createTagLinks(
  moodEntryId: string,
  keys: string[],
  db: TagLinkDb = prisma,
  ratedFactors: RatedFactorInput[] = [],
): Promise<void> {
  // Resolve rated factors FIRST so an out-of-range rating aborts before
  // any write, and so the rated rows (which carry a value) take priority
  // over a bare binary row for the same tag id under `skipDuplicates`.
  const resolvedFactors = await resolveRatedFactors(ratedFactors, db);
  const ratedTagIds = new Set(resolvedFactors.map((f) => f.moodTagId));

  if (resolvedFactors.length > 0) {
    await db.moodEntryTagLink.createMany({
      // Field-by-field — no mass assignment of the wire object.
      data: resolvedFactors.map((f) => ({
        moodEntryId,
        moodTagId: f.moodTagId,
        rating: f.rating,
      })),
      skipDuplicates: true,
    });
  }

  const tagIds = (await resolveTagKeysToIds(keys, db)).filter(
    // A key already written as a rated link is not re-inserted as a
    // bare binary row (that would lose the rating to `skipDuplicates`).
    (id) => !ratedTagIds.has(id),
  );
  if (tagIds.length === 0) return;
  await db.moodEntryTagLink.createMany({
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
  db: TagLinkDb = prisma,
): Promise<void> {
  const desiredIds = new Set(await resolveTagKeysToIds(keys, db));
  const existing = await db.moodEntryTagLink.findMany({
    where: { moodEntryId },
    select: { moodTagId: true },
  });
  const existingIds = new Set(existing.map((row) => row.moodTagId));

  const toDelete = [...existingIds].filter((id) => !desiredIds.has(id));
  const toCreate = [...desiredIds].filter((id) => !existingIds.has(id));

  if (toDelete.length > 0) {
    await db.moodEntryTagLink.deleteMany({
      where: { moodEntryId, moodTagId: { in: toDelete } },
    });
  }
  if (toCreate.length > 0) {
    await db.moodEntryTagLink.createMany({
      data: toCreate.map((moodTagId) => ({ moodEntryId, moodTagId })),
      skipDuplicates: true,
    });
  }
}

/**
 * v1.12.0 — replace the full rated-factor link set for an entry. A
 * changed rating on the same factor is a real change (not a no-op), so
 * the simplest correct shape is "delete every RATED link for the entry,
 * re-insert the desired set". Binary links are left untouched. Passing an
 * empty array clears every rated link. Throws `RatedFactorOutOfRangeError`
 * (→ route 422) before any write when a rating is out of scale.
 *
 * Not wired into a route yet (the POST + bulk ingestion contract is the
 * v1.12.0 scope); exported for the PATCH edit path a later wave adds.
 */
export async function replaceRatedFactorLinks(
  moodEntryId: string,
  factors: RatedFactorInput[],
  db: TagLinkDb = prisma,
): Promise<void> {
  // Resolve (and range-check) before mutating so an out-of-range rating
  // aborts the replace cleanly.
  const resolved = await resolveRatedFactors(factors, db);

  // Drop every existing RATED link for the entry (a `rating IS NOT NULL`
  // row is, by construction, a rated-factor link).
  await db.moodEntryTagLink.deleteMany({
    where: { moodEntryId, rating: { not: null } },
  });

  if (resolved.length > 0) {
    await db.moodEntryTagLink.createMany({
      data: resolved.map((f) => ({
        moodEntryId,
        moodTagId: f.moodTagId,
        rating: f.rating,
      })),
      skipDuplicates: true,
    });
  }
}
