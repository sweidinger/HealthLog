/**
 * v1.12.0 — rated mood factors: resolver + write-path unit coverage.
 *
 * `resolveRatedFactors` resolves catalog keys, drops unknown / non-RATED
 * keys, and rejects an out-of-scale rating. `createTagLinks` persists the
 * rating onto the join and de-dupes a key passed both as a binary key and
 * a rated factor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const moodTagFindMany = vi.fn();
const linkCreateMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@/lib/db", () => ({
  prisma: {
    moodTag: { findMany: (...a: unknown[]) => moodTagFindMany(...a) },
    moodEntryTagLink: { createMany: (...a: unknown[]) => linkCreateMany(...a) },
  },
}));

import {
  resolveRatedFactors,
  createTagLinks,
  RatedFactorOutOfRangeError,
} from "@/lib/mood/tag-links";

beforeEach(() => {
  moodTagFindMany.mockReset();
  linkCreateMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("resolveRatedFactors", () => {
  it("resolves a valid factor to its catalog id + rating", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);
    const out = await resolveRatedFactors([{ key: "factor_work", rating: 4 }]);
    expect(out).toEqual([{ moodTagId: "mt_factor_work", rating: 4 }]);
  });

  it("drops unknown / non-RATED keys (catalog is the source of truth)", async () => {
    // The query already filters by `kind: 'RATED'` + `isActive`, so an
    // unknown / binary key simply doesn't come back.
    moodTagFindMany.mockResolvedValue([]);
    const out = await resolveRatedFactors([{ key: "happy", rating: 3 }]);
    expect(out).toEqual([]);
  });

  it("rejects a rating above the factor's scaleMax", async () => {
    moodTagFindMany.mockResolvedValue([
      {
        id: "mt_factor_conflict",
        key: "factor_conflict",
        scaleMin: 1,
        scaleMax: 2,
      },
    ]);
    await expect(
      resolveRatedFactors([{ key: "factor_conflict", rating: 4 }]),
    ).rejects.toBeInstanceOf(RatedFactorOutOfRangeError);
  });

  it("rejects a rating below the factor's scaleMin", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);
    await expect(
      resolveRatedFactors([{ key: "factor_work", rating: 0 }]),
    ).rejects.toBeInstanceOf(RatedFactorOutOfRangeError);
  });

  it("is a no-op on an empty input", async () => {
    const out = await resolveRatedFactors([]);
    expect(out).toEqual([]);
    expect(moodTagFindMany).not.toHaveBeenCalled();
  });
});

describe("createTagLinks with rated factors", () => {
  it("persists the rating onto the join row", async () => {
    moodTagFindMany.mockResolvedValue([
      { id: "mt_factor_work", key: "factor_work", scaleMin: 1, scaleMax: 5 },
    ]);
    await createTagLinks("entry-1", [], undefined, [
      { key: "factor_work", rating: 5 },
    ]);
    expect(linkCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ moodEntryId: "entry-1", moodTagId: "mt_factor_work", rating: 5 }],
      }),
    );
  });

  it("propagates the out-of-range error before any write", async () => {
    moodTagFindMany.mockResolvedValue([
      {
        id: "mt_factor_conflict",
        key: "factor_conflict",
        scaleMin: 1,
        scaleMax: 2,
      },
    ]);
    await expect(
      createTagLinks("entry-1", [], undefined, [
        { key: "factor_conflict", rating: 5 },
      ]),
    ).rejects.toBeInstanceOf(RatedFactorOutOfRangeError);
    expect(linkCreateMany).not.toHaveBeenCalled();
  });
});
