import { describe, expect, it, vi } from "vitest";

import { bucketRowsByDay, scanSourceRowsPaged } from "../consolidation-base";
import type { PerSampleRow } from "../consolidation-tz";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

// `scanSourceRowsPaged` keyset-paginates the per-(user, type) source scan so a
// multi-year tenant no longer materialises its whole history in one Prisma
// result set. These tests pin the two properties that matter: the accumulated
// array equals a single unbounded scan (same rows, same order, no gaps /
// duplicates), and the cursor advances on `(measuredAt, id)` after every full
// page.

/** Build a deterministic per-sample row at a 1-minute-per-index offset. */
function row(index: number): PerSampleRow {
  return {
    id: `m-${String(index).padStart(4, "0")}`,
    type: "ACTIVITY_STEPS",
    value: index,
    measuredAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)),
    externalId: `hk-uuid-${index}`,
  };
}

/**
 * A findMany mock that serves `allRows` in keyset order, honouring `take`
 * (page size) and the `(measuredAt, id)` cursor clause the helper AND-combines
 * onto the base where. This mirrors how Postgres would resolve the keyset.
 */
function buildPagingFindMany(allRows: PerSampleRow[]) {
  const ordered = [...allRows].sort((a, b) => {
    const byTime = a.measuredAt.getTime() - b.measuredAt.getTime();
    return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return vi.fn(
    async (args: {
      where: Prisma.MeasurementWhereInput;
      take?: number;
      orderBy?: unknown;
    }) => {
      const take = args.take ?? ordered.length;

      // Extract the keyset cursor the helper threads through `where.AND[1].OR`.
      let afterTime: number | null = null;
      let afterId: string | null = null;
      const and = (args.where as { AND?: unknown[] }).AND;
      if (Array.isArray(and)) {
        const or = (and[1] as { OR?: Array<Record<string, unknown>> }).OR;
        const gt = or?.[0]?.measuredAt as { gt?: Date } | undefined;
        const tie = or?.[1] as
          | { measuredAt?: Date; id?: { gt?: string } }
          | undefined;
        afterTime = gt?.gt ? gt.gt.getTime() : null;
        afterId = tie?.id?.gt ?? null;
      }

      const remaining =
        afterTime === null
          ? ordered
          : ordered.filter((r) => {
              const t = r.measuredAt.getTime();
              return t > afterTime! || (t === afterTime! && r.id > afterId!);
            });

      return remaining.slice(0, take);
    },
  );
}

function mockClient(findMany: ReturnType<typeof vi.fn>): PrismaClient {
  return {
    measurement: { findMany },
  } as unknown as PrismaClient;
}

const BASE_WHERE: Prisma.MeasurementWhereInput = {
  userId: "user-1",
  type: "ACTIVITY_STEPS",
};
const SELECT: Prisma.MeasurementSelect = {
  id: true,
  type: true,
  value: true,
  measuredAt: true,
  externalId: true,
};

describe("scanSourceRowsPaged", () => {
  it("accumulates every row in keyset order across multiple pages with no gaps or duplicates", async () => {
    const all = Array.from({ length: 23 }, (_, i) => row(i));
    const findMany = buildPagingFindMany(all);

    const result = await scanSourceRowsPaged(
      mockClient(findMany),
      BASE_WHERE,
      SELECT,
      10,
    );

    // 23 rows at page size 10 → pages of 10, 10, 3 (the short page ends it).
    expect(result.map((r) => r.id)).toEqual(all.map((r) => r.id));
    expect(new Set(result.map((r) => r.id)).size).toBe(all.length);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("issues exactly one extra probing page when the row count is an exact multiple of the page size", async () => {
    const all = Array.from({ length: 20 }, (_, i) => row(i));
    const findMany = buildPagingFindMany(all);

    const result = await scanSourceRowsPaged(
      mockClient(findMany),
      BASE_WHERE,
      SELECT,
      10,
    );

    // 20 rows at page size 10 → full pages 10, 10, then an empty probe page.
    expect(result).toHaveLength(20);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("advances the cursor on (measuredAt, id) after each full page", async () => {
    const all = Array.from({ length: 12 }, (_, i) => row(i));
    const findMany = buildPagingFindMany(all);

    await scanSourceRowsPaged(mockClient(findMany), BASE_WHERE, SELECT, 5);

    // First page: no cursor (base where only).
    const firstWhere = findMany.mock.calls[0]?.[0]?.where;
    expect((firstWhere as { AND?: unknown }).AND).toBeUndefined();
    expect(firstWhere).toEqual(BASE_WHERE);

    // Second page: cursor resumes after the 5th row (id m-0004).
    const secondWhere = findMany.mock.calls[1]?.[0]?.where as {
      AND: unknown[];
    };
    expect(Array.isArray(secondWhere.AND)).toBe(true);
    expect(secondWhere.AND[0]).toEqual(BASE_WHERE);
    const cursorClause = secondWhere.AND[1] as {
      OR: Array<{ measuredAt?: { gt?: Date }; id?: { gt?: string } }>;
    };
    expect(cursorClause.OR[0].measuredAt?.gt).toEqual(row(4).measuredAt);
    expect(cursorClause.OR[1].id?.gt).toBe(row(4).id);

    // Every page is requested in stable keyset order.
    for (const call of findMany.mock.calls) {
      expect(call[0]?.orderBy).toEqual([{ measuredAt: "asc" }, { id: "asc" }]);
    }
  });

  it("returns the empty array when the first page is empty", async () => {
    const findMany = buildPagingFindMany([]);
    const result = await scanSourceRowsPaged(
      mockClient(findMany),
      BASE_WHERE,
      SELECT,
      10,
    );
    expect(result).toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("produces output that buckets identically to a single unpaged scan", async () => {
    // Rows spanning three calendar days; the paged accumulation must bucket
    // byte-identically to the same rows fed in one array.
    const all = [
      { ...row(1), measuredAt: new Date("2026-05-16T08:00:00.000Z") },
      { ...row(2), measuredAt: new Date("2026-05-16T14:00:00.000Z") },
      { ...row(3), measuredAt: new Date("2026-05-17T06:00:00.000Z") },
      { ...row(4), measuredAt: new Date("2026-05-17T20:00:00.000Z") },
      { ...row(5), measuredAt: new Date("2026-05-18T09:00:00.000Z") },
    ];
    const findMany = buildPagingFindMany(all);

    const paged = await scanSourceRowsPaged(
      mockClient(findMany),
      BASE_WHERE,
      SELECT,
      2,
    );

    const baselineByDay = bucketRowsByDay(all, "Europe/Berlin", "stats:");
    const pagedByDay = bucketRowsByDay(paged, "Europe/Berlin", "stats:");

    expect([...pagedByDay.keys()].sort()).toEqual(
      [...baselineByDay.keys()].sort(),
    );
    for (const [dateKey, rows] of baselineByDay) {
      expect(pagedByDay.get(dateKey)?.map((r) => r.id)).toEqual(
        rows.map((r) => r.id),
      );
    }
  });
});
