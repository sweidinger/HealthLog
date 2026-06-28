/**
 * v1.25 — hydration daily-goal surface.
 *
 *   GET  /api/hydration  → today's summed water intake vs the user's goal.
 *   PATCH /api/hydration  → set the per-user daily goal (ml).
 *
 * Logging itself rides the existing measurements create path (POST
 * /api/measurements with `type: "WATER_INTAKE"`, unit "ml") — this route only
 * reads the day's total and owns the goal. `userId` is always narrowed from
 * `requireAuth()`; the goal is built field-by-field, never mass-assigned.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import {
  MAX_HYDRATION_GOAL_ML,
  MIN_HYDRATION_GOAL_ML,
  resolveHydrationGoal,
  summariseHydration,
} from "@/lib/hydration/hydration";

export const dynamic = "force-dynamic";

const goalPatchSchema = z.object({
  goalMl: z
    .number()
    .int()
    .min(MIN_HYDRATION_GOAL_ML)
    .max(MAX_HYDRATION_GOAL_ML),
});

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many requests. Please retry later.", 429);
  }

  const now = new Date();
  const { start, end } = getUserTodayBounds(now, user.timezone);

  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "WATER_INTAKE",
      measuredAt: { gte: start, lte: end },
    },
    select: { id: true, value: true, measuredAt: true },
    orderBy: { measuredAt: "asc" },
  });

  const totalMl = rows.reduce((sum, r) => sum + r.value, 0);
  const summary = summariseHydration(
    totalMl,
    resolveHydrationGoal(user.hydrationGoalMl),
  );

  annotate({
    action: { name: "hydration.today.read" },
    meta: { entries: rows.length, met: summary.met },
  });

  return apiSuccess({
    date: start.toISOString(),
    ...summary,
    entries: rows.map((r) => ({
      id: r.id,
      value: r.value,
      measuredAt: r.measuredAt.toISOString(),
    })),
  });
});

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 1024,
  });
  if (jsonError) return jsonError;

  const parsed = goalPatchSchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "hydration.goal.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const goalMl = parsed.data.goalMl;
  await prisma.user.update({
    where: { id: user.id },
    data: { hydrationGoalMl: goalMl },
  });

  annotate({ action: { name: "hydration.goal.update" }, meta: { goalMl } });

  return apiSuccess({ goalMl });
});
