/**
 * v1.10.0 — generic derived-wellness-metric route.
 *
 * `GET /api/insights/derived?metric=<DERIVED_METRIC_ID>[&type=<MeasurementType>]`
 * serves the compute-once `Derived<T>` value for any metric registered
 * in `derived/registry.ts`. Mirrors the v1.8.7.1 `metric-status` route
 * precedent: `apiHandler` wrapper, Zod `safeParse` on the query, a closed
 * registry enum (unknown id → 422 via `returnAllZodIssues`), cookie OR
 * Bearer auth, `userId` narrowed from the session/Bearer (never a query
 * field).
 *
 * The `data` payload is the flat `Derived<T>` union so iOS can decode +
 * combine values across metrics: `{ metric, status, value?, coverage,
 * confidence?, provenance, reason? }`. Numbers are pure compute over the
 * rollup tier (Tier-1, no narrative) — no provider call, no cache table.
 *
 * Wave 1 implements `VITALS_BASELINE` end-to-end; other registered ids
 * return a `not_implemented` insufficient until their compute lands in a
 * later wave (never a 500, never a fabricated value).
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { prisma } from "@/lib/db";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  computeDerivedMetric,
  DERIVED_METRIC_IDS,
  type DerivedMetricId,
} from "@/lib/insights/derived";

export const dynamic = "force-dynamic";

// Closed enum derived from the registry so the route + registry cannot
// drift — an id added to the registry is accepted automatically, an
// unknown id 422s rather than silently resolving to no metric.
const derivedQuerySchema = z.object({
  metric: z.enum(DERIVED_METRIC_IDS as [string, ...string[]]),
  // Optional sub-target for metrics that baseline a single chosen vital
  // (VITALS_BASELINE). Validated against the engine's supported set in
  // the dispatcher; an unsupported value yields an `insufficient`, not a
  // 422, so the contract stays forgiving for iOS combinations.
  type: z.string().optional(),
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  await requireAssistantSurface("insightStatus");

  const parsed = derivedQuerySchema.safeParse({
    metric: request.nextUrl.searchParams.get("metric"),
    type: request.nextUrl.searchParams.get("type") ?? undefined,
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.derived.invalid-metric" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }
  const metric = parsed.data.metric as DerivedMetricId;

  // Profile read once, passed into the pure compute function (never
  // re-fetched per metric — the pool-contention mitigation).
  const profile = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dateOfBirth: true, gender: true, heightCm: true },
  });
  const sex =
    profile?.gender === "MALE" || profile?.gender === "FEMALE"
      ? profile.gender
      : null;

  const derived = await computeDerivedMetric({
    metric,
    userId: user.id,
    profile: {
      ageYears: getAgeFromDateOfBirth(profile?.dateOfBirth ?? null),
      sex,
      heightCm: profile?.heightCm ?? null,
    },
    type: parsed.data.type ?? null,
  });

  annotate({
    action: { name: "insights.derived" },
    meta: { metric, status: derived.status },
  });

  // Flatten the discriminated union for the wire: `metric` tags it,
  // `value`/`reason` are nullable so iOS decodes one stable shape.
  return apiSuccess({
    metric,
    status: derived.status,
    value: derived.status === "ok" ? derived.value : null,
    coverage: derived.coverage,
    confidence: derived.status === "ok" ? derived.confidence : null,
    provenance: derived.provenance,
    reason: derived.status === "insufficient" ? derived.reason : null,
  });
});
