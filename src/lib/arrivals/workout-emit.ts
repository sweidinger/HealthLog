/**
 * The provider-sync workout seam.
 *
 * The four provider syncs (WHOOP, Fitbit, Google Health, Strava) all persist a
 * workout with `prisma.workout.upsert`, and an upsert cannot say whether it
 * created a row or updated one. That distinction is the whole point of the
 * spine: a re-sync must be silent. WHOOP alone re-posts the same recent workout
 * on every poll, so without it a single day's session would emit a fresh
 * arrival — and dispatch a fresh downstream reaction — every polling interval,
 * indefinitely.
 *
 * `wasJustCreated` recovers the distinction for free, from the row the upsert
 * already returned, rather than paying an existence probe per workout on what
 * is also the backfill path. See its docblock for why the comparison is sound.
 */
import { emitDataArrival } from "./emit-shared";

/** The subset of a `Workout` row this seam needs back from an upsert. */
export interface UpsertedWorkoutRow {
  id: string;
  startedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * True when the upsert CREATED this row rather than updating an existing one.
 *
 * `createdAt` is `@default(now())` and `updatedAt` is `@updatedAt`, so Prisma
 * writes both from the same statement on a create and they are byte-identical.
 * Any subsequent update bumps `updatedAt` alone, leaving it strictly greater.
 * The two can therefore only be equal on a row that has never been updated,
 * which — on an upsert path where every update writes the full row — means the
 * upsert just created it.
 *
 * The alternative is an indexed existence probe before every upsert, which is
 * the pattern `import-apple-health-export.ts` uses because it can batch the
 * probe across a chunk. These seams upsert one workout at a time, so a probe
 * would double the query count on exactly the path (a provider backfill) that
 * most needs to stay cheap.
 */
export function wasJustCreated(row: {
  createdAt: Date;
  updatedAt: Date;
}): boolean {
  return row.createdAt.getTime() === row.updatedAt.getTime();
}

/**
 * Emit a workout arrival for a just-upserted row, but only if the upsert
 * actually created it. Best-effort: never throws, never fails the sync.
 *
 * The recency classifier still runs inside `emitDataArrival`, so a provider
 * backfill that legitimately CREATES hundreds of historical rows still emits
 * zero events — the created-vs-updated test and the recency test are two
 * independent gates, and a backfill fails the second one.
 */
export async function emitWorkoutArrivalIfCreated(
  userId: string,
  row: UpsertedWorkoutRow,
  source: string,
): Promise<void> {
  if (!wasJustCreated(row)) return;
  await emitDataArrival({
    userId,
    kind: "workout",
    newestSampleAt: row.startedAt,
    insertedCount: 1,
    refId: row.id,
    source,
  });
}
