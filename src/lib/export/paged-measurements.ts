/**
 * Keyset-paginated measurement reader for the export surfaces.
 *
 * The legacy exports (`GET /api/export`, `GET /api/export/measurements`, the
 * full-backup builder) read the user's ENTIRE measurement table in one
 * `findMany`. On a CGM + per-sample-HR account that is a six-figure row set
 * materialised by a single query — the v1.28.2x incident class. This helper
 * keeps the output row set (and its `measuredAt desc` order) identical while
 * bounding each database round-trip to `MEASUREMENT_EXPORT_PAGE_SIZE` rows:
 * the driver never buffers one giant result, and the event loop yields
 * between chunks.
 *
 * Ordering: `measuredAt desc, id desc`. The exports always sorted
 * `measuredAt desc`; the `id` tie-breaker makes the keyset cursor total (two
 * rows can share a timestamp) — for equal-timestamp rows the previous order
 * was unspecified heap order, so pinning it is not a behaviour change any
 * consumer could have relied on.
 *
 * The `select` MUST include `id` (the cursor key); the generic constraint
 * enforces it at compile time.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export const MEASUREMENT_EXPORT_PAGE_SIZE = 10_000;

export async function findMeasurementsPaged<
  S extends Prisma.MeasurementSelect & { id: true },
>(
  db: PrismaClient,
  where: Prisma.MeasurementWhereInput,
  select: S,
  pageSize: number = MEASUREMENT_EXPORT_PAGE_SIZE,
): Promise<Array<Prisma.MeasurementGetPayload<{ select: S }>>> {
  const rows: Array<Prisma.MeasurementGetPayload<{ select: S }>> = [];
  let cursorId: string | null = null;
  for (;;) {
    const batch: Array<Prisma.MeasurementGetPayload<{ select: S }>> =
      (await db.measurement.findMany({
        where,
        orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        take: pageSize,
        ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
        select,
      })) as Array<Prisma.MeasurementGetPayload<{ select: S }>>;
    // Loop, not `push(...batch)` — a 10k-element spread is fine today, but
    // this file exists because of stack-overflow-by-spread regressions on
    // large arrays (v1.28.22 class); keep the pattern boring.
    for (const row of batch) rows.push(row);
    if (batch.length < pageSize) break;
    cursorId = (batch[batch.length - 1] as { id: string }).id;
  }
  return rows;
}
