/**
 * `POST /api/mood-entries/bulk-delete` — multi-select soft-delete for the
 * mood management list (v1.15.13).
 *
 * Body:
 *   { ids: string[] }   — 1..200 mood-entry ids, scoped to the caller.
 *
 * Soft-deletes (tombstones) every owned, not-already-deleted row in one
 * `updateMany` — matching the single-DELETE iOS tombstone contract. A
 * forged / foreign id is a silent no-op (never a 404 existence leak): the
 * mutation `where` pins `userId` so it only ever touches the caller's rows.
 *
 * Response (200):
 *   { deleted: <number of rows tombstoned> }
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

const MAX_IDS_PER_BATCH = 200;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_IDS_PER_BATCH),
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulkDelete));

async function postBulkDelete(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const rl = await checkRateLimit(
    `mood-entries:bulk-delete:${user.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk deletions, try again later", 429);
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 256 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = bulkDeleteSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.bulk-delete.invalid",
    });
  }

  const { ids } = parsed.data;
  const now = new Date();

  // Read the soon-to-be-tombstoned rows first so we know which days need
  // a mood-rollup recompute. Ownership-scoped + `deletedAt: null` so a
  // forged / foreign / already-tombstoned id is excluded here exactly as
  // it is from the mutation below — no existence leak.
  const affected = await prisma.moodEntry.findMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    select: { moodLoggedAt: true },
  });

  // Soft-delete (tombstone) in one statement. The `where` pins `userId`
  // so a forged id for another user is silently a no-op; `deletedAt: null`
  // keeps the count honest (an already-tombstoned id doesn't re-count).
  const { count } = await prisma.moodEntry.updateMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    data: { deletedAt: now, syncVersion: { increment: 1 } },
  });

  await auditLog("mood.delete.bulk", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count },
  });

  annotate({
    action: { name: "mood.delete.bulk" },
    meta: { count },
  });

  if (count > 0) {
    // v1.4.34 IW-G — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.4.39 W-MOOD — collapse the deleted rows to the unique
    // `(user, dayStart)` set BEFORE recomputing so a bulk delete spanning
    // one day fires one recompute, not one per row. Best-effort — a
    // populator hiccup never fails the user's delete.
    const touchedDayStarts = new Set<number>();
    for (const row of affected) {
      const d = row.moodLoggedAt;
      touchedDayStarts.add(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
      );
    }
    try {
      await Promise.all(
        Array.from(touchedDayStarts).map((t) =>
          recomputeMoodBucketsForEntry(user.id, new Date(t)),
        ),
      );
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }
  }

  return apiSuccess({ deleted: count });
}
