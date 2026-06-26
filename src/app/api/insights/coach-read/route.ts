/**
 * v1.22.0 (A1) — "Coach read" strip route.
 *
 * `GET /api/insights/coach-read?metric=<MeasurementType>` serves the two
 * server-authoritative lines a metric sub-page renders above its chart: the
 * own-baseline placement (median ± k·MAD, today's reading within / above /
 * below) and the single strongest lagged association whose outcome is the
 * metric. Pure compute over the baseline + correlation engines — no provider
 * call, no cache table — so web and iOS decode the SAME resolved DTO.
 *
 * Mirrors the `/api/insights/derived` precedent: `apiHandler` wrapper, Zod
 * `safeParse` on the query (unknown `metric` → 422 via `returnAllZodIssues`),
 * cookie OR Bearer auth, `userId` narrowed from the session (never a query
 * field), insights-module gate, and the shared analytics-read budget.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { buildCoachReadStrip } from "@/lib/insights/derived/coach-read";
import type { MeasurementType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const coachReadQuerySchema = z.object({
  metric: measurementTypeEnum,
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;

  // Shared analytics-read budget — generous; caps a runaway navigation loop.
  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const parsed = coachReadQuerySchema.safeParse({
    metric: request.nextUrl.searchParams.get("metric"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.coach-read.invalid-metric" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const metric = parsed.data.metric as MeasurementType;

  const strip = await buildCoachReadStrip(user.id, metric);

  annotate({
    action: { name: "insights.coach-read" },
    meta: {
      metric,
      has_baseline: strip.baseline !== null,
      learning: strip.learning,
      has_driver: strip.driver !== null,
    },
  });

  return apiSuccess(strip);
});
