/**
 * `GET /api/workouts` — paginated workout list with cross-source
 * canonical-row dedup.
 *
 * Consumers (v1.4.32+):
 *   1. The `/insights/workouts` web surface reads from this endpoint so
 *      duplicate twin workouts (Apple Watch writing a workout that
 *      Withings also published over its server-to-server feed) collapse
 *      to a single canonical row per cluster.
 *   2. The native iOS app drains historical workouts through the same
 *      surface — Apple Health is the canonical ladder anchor, so an
 *      iOS-originated request typically returns its own rows back.
 *
 * Dedup contract:
 *   - The route runs `pickCanonicalWorkoutRows()` from v1.4.30 over the
 *     filtered row set. The picker reads the per-user
 *     `User.sourcePriorityJson` blob (falling back to
 *     `APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT`) and buckets by
 *     `(startedAt slot-of-5-min, sportType)`. The highest-priority
 *     source's rows win each bucket; the rest are dropped.
 *
 * Query params:
 *   - `limit` (default 50, max 200)
 *   - `offset` (default 0)
 *   - `since` / `until` — ISO timestamps, inclusive. Optional.
 *   - `sportType` — narrow to one HKWorkoutActivityType. Optional.
 *
 * Pagination contract:
 *   Dedup runs over the full filtered row set, then `offset` / `limit`
 *   slice the canonical projection. A naive `skip` + per-window dedup
 *   double-counts boundary clusters across pages because a cluster
 *   whose first member sits in page N-1 and whose later member sits in
 *   page N would be dropped on N-1 and surface again on N.
 *
 *   The canonical projection (the deduped, sorted row set) is cached
 *   keyed on the FILTER (`userId|since|until|sportType`) — deliberately
 *   WITHOUT `offset`/`limit` — so every page of a drain shares one cache
 *   entry: the first page's request builds it (one `findMany` + one
 *   dedup pass), every later page in the same TTL window slices the
 *   already-built array for free. Before this, each page carried its own
 *   cache key, so a full historical drain (the iOS app's "drain
 *   historical workouts" path, potentially thousands of rows on a
 *   10-year Apple Health import) re-ran the full read + dedup once per
 *   page — O(pages × rows) instead of O(rows).
 *
 * Response shape (iOS contract):
 *   - `workouts: WorkoutListEntry[]` — each entry exposes
 *     `id, sportType, startedAt, endedAt, durationSec, distanceM,
 *     activeEnergyKcal, avgHr, maxHr, source, externalId`. Stable across
 *     iOS / web consumers.
 *   - `meta: { total, limit, offset, droppedDuplicates }`.
 *
 * v1.4.32 — swap the cluster-based dedup helper (v1.4.27 B7) for the
 * source-priority-aware `pickCanonicalWorkoutRows()` helper (v1.4.30)
 * so the per-user source ladder governs the canonical pick. Response
 * field names match the iOS handoff contract.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { pickCanonicalWorkoutRows } from "@/lib/measurements/pick-canonical-workout-rows";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import { requireModuleEnabled } from "@/lib/modules/gate";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface WorkoutsParams {
  readonly limit: number;
  readonly offset: number;
  readonly since: string | null;
  readonly until: string | null;
  readonly sportType: string | null;
}

type WorkoutFilterParams = Pick<
  WorkoutsParams,
  "since" | "until" | "sportType"
>;

interface CanonicalWorkoutRow {
  id: string;
  source: string;
  externalId: string | null;
  sportType: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSec: number | null;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  createdAt: Date;
}

/** The cached, deduped, most-recent-first row set for one filter combination. */
interface WorkoutsProjection {
  canonical: CanonicalWorkoutRow[];
  rawCount: number;
}

interface WorkoutsResult {
  workouts: Array<{
    id: string;
    sportType: string | null;
    startedAt: Date | null;
    endedAt: Date | null;
    durationSec: number | null;
    distanceM: number | null;
    activeEnergyKcal: number | null;
    avgHr: number | null;
    maxHr: number | null;
    source: string;
    externalId: string | null;
  }>;
  meta: {
    total: number;
    limit: number;
    offset: number;
    droppedDuplicates: number;
  };
}

async function buildWorkoutsProjection(
  userId: string,
  params: WorkoutFilterParams,
): Promise<WorkoutsProjection> {
  const { since, until, sportType } = params;

  const where: Record<string, unknown> = { userId };
  if (since || until) {
    const range: Record<string, Date> = {};
    if (since) {
      const d = new Date(since);
      if (!Number.isNaN(d.getTime())) range.gte = d;
    }
    if (until) {
      const d = new Date(until);
      if (!Number.isNaN(d.getTime())) range.lte = d;
    }
    if (Object.keys(range).length > 0) {
      where.startedAt = range;
    }
  }
  if (sportType) {
    where.sportType = sportType;
  }

  // Independent reads — the sourcePriorityJson lookup doesn't depend on the
  // row read, so run them concurrently rather than paying two sequential
  // round trips.
  const [rows, userRow] = await Promise.all([
    prisma.workout.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        source: true,
        externalId: true,
        sportType: true,
        startedAt: true,
        endedAt: true,
        durationSec: true,
        totalDistanceM: true,
        totalEnergyKcal: true,
        avgHeartRate: true,
        maxHeartRate: true,
        createdAt: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { sourcePriorityJson: true },
    }),
  ]);

  const canonical = pickCanonicalWorkoutRows(
    rows,
    userRow?.sourcePriorityJson ?? null,
  );

  // `pickCanonicalWorkoutRows` re-sorts its output to `startedAt ASC` (its
  // documented contract for the rollup callers). This surface is a
  // most-recent-first list, so the DB `orderBy startedAt desc` must be
  // re-established AFTER the pick — otherwise `offset`/`limit` slice the
  // OLDEST page and a user with a long history never sees recent workouts.
  canonical.sort((a, b) => {
    const delta = (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0);
    if (delta !== 0) return delta;
    return a.id.localeCompare(b.id);
  });

  return { canonical, rawCount: rows.length };
}

function sliceWorkoutsProjection(
  projection: WorkoutsProjection,
  limit: number,
  offset: number,
): WorkoutsResult {
  const page = projection.canonical
    .slice(offset, offset + limit)
    .map((row) => ({
      id: row.id,
      sportType: row.sportType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      distanceM: row.totalDistanceM,
      activeEnergyKcal: row.totalEnergyKcal,
      avgHr: row.avgHeartRate,
      maxHr: row.maxHeartRate,
      source: row.source,
      externalId: row.externalId,
    }));

  return {
    workouts: page,
    meta: {
      total: projection.canonical.length,
      limit,
      offset,
      droppedDuplicates: projection.rawCount - projection.canonical.length,
    },
  };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "workouts.list" } });

  // v1.18.0 B1 — the workouts surface is a toggleable module. A disabled
  // account must not be able to read the list even with a valid Bearer
  // token. The batch INGEST route stays ungated so synced data still
  // lands while the surface is hidden.
  const gate = await requireModuleEnabled(user.id, "workouts");
  if (!gate.enabled) return gate.response;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(
    Math.max(
      1,
      parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) ||
        DEFAULT_LIMIT,
    ),
    MAX_LIMIT,
  );
  const offset = Math.max(
    0,
    parseInt(searchParams.get("offset") ?? "0", 10) || 0,
  );
  const since = searchParams.get("since");
  const until = searchParams.get("until");
  const sportType = searchParams.get("sportType");

  // Deliberately excludes `limit`/`offset` — every page of one filter
  // combination shares this cached projection (see the docblock above).
  const projectionKey = `${user.id}|${since ?? ""}|${until ?? ""}|${sportType ?? ""}`;

  const projection = await cached(
    caches.workouts as ServerCache<WorkoutsProjection>,
    projectionKey,
    () => buildWorkoutsProjection(user.id, { since, until, sportType }),
    annotate,
  );

  const result = sliceWorkoutsProjection(projection, limit, offset);

  return apiSuccess(result);
});
