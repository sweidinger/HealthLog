/**
 * v1.10.0 — batched derived-wellness-metric route.
 *
 * `GET /api/insights/derived/batch?metrics=<id,id,…>[&types=<type,…>]`
 * resolves several derived metrics in ONE request and returns a map keyed
 * by the per-request key (`<metric>` or `<metric>:<type>` for a
 * VITALS_BASELINE sub-target). It exists to collapse the Insights cold
 * mount's 14+ independent `GET /api/insights/derived` requests — each
 * sharing one Prisma pool — into a single request that fans out
 * server-side under a bounded `p-limit`, the exact pool-starvation class
 * that bit v1.4.49.1 / v1.4.40 (the "app hangs then recovers" symptom).
 *
 * Honors the same contract as the single route: closed registry enum
 * (unknown id → 422), cookie OR Bearer auth, `userId` narrowed from the
 * session (never a query field), pure compute over the rollup tier (no
 * provider call, no cache table). The profile is loaded ONCE via the
 * shared `loadBaselineProfile` and threaded into every compute, so the
 * batch never re-reads the `User` row per metric.
 *
 * The single-metric route stays for the anatomy detail pages (one metric
 * per page); this route backs the dashboard's one-shot grid read.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import pLimit from "p-limit";
import { apiSuccess, apiError, returnAllZodIssues } from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { prisma } from "@/lib/db";
import {
  computeDerivedMetric,
  loadBaselineProfile,
  isDerivedMetricId,
  type DerivedMetricId,
} from "@/lib/insights/derived";
import { resolveDeterministicAssessment } from "@/lib/insights/derived/derived-assessment";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

export const dynamic = "force-dynamic";

// Bounded internal fan-out — matches the W-POOL `p-limit(4)` discipline
// v1.4.40 applied to the per-type analytics walk so a batch of 14 metrics
// never floods the shared Prisma pool.
const BATCH_CONCURRENCY = 4;
// Defensive ceiling — the dashboard requests ~11 metrics + ~6 baseline
// sub-targets; cap the list so a crafted query can't fan out unbounded.
const MAX_METRICS = 24;

/**
 * A single batch request item: a registered metric id with an optional
 * VITALS_BASELINE sub-target. The wire form is `metric` or `metric:type`
 * inside the `metrics` CSV; an entry's `type` is parsed off the colon.
 */
interface BatchItem {
  metric: DerivedMetricId;
  type: string | null;
  /** The map key the response is keyed by (mirrors the request token). */
  key: string;
}

const batchQuerySchema = z.object({
  metrics: z
    .string()
    .min(1)
    .max(1024)
    .describe("CSV of derived-metric tokens (`metric` or `metric:type`)."),
});

/**
 * Parse the `metrics` CSV into validated items. An entry `metric:type`
 * sub-targets a VITALS_BASELINE vital; a bare `metric` carries no type.
 * Unknown ids are returned as `invalid` so the route 422s the whole
 * request rather than silently dropping a metric (the closed-enum rule).
 * Duplicate keys collapse to one item (last write wins) so a repeated
 * token can't inflate the fan-out.
 */
function parseBatchItems(csv: string): {
  items: BatchItem[];
  invalid: string[];
} {
  const seen = new Map<string, BatchItem>();
  const invalid: string[] = [];
  for (const raw of csv.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    const colon = token.indexOf(":");
    const metric = colon === -1 ? token : token.slice(0, colon);
    const type = colon === -1 ? null : token.slice(colon + 1) || null;
    if (!isDerivedMetricId(metric)) {
      invalid.push(metric);
      continue;
    }
    const key = type ? `${metric}:${type}` : metric;
    seen.set(key, { metric, type, key });
  }
  return { items: [...seen.values()], invalid };
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  await requireAssistantSurface("insightStatus");

  const parsed = batchQuerySchema.safeParse({
    metrics: request.nextUrl.searchParams.get("metrics"),
  });
  if (!parsed.success) {
    annotate({
      action: { name: "insights.derived.batch.invalid-query" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { items, invalid } = parseBatchItems(parsed.data.metrics);
  if (invalid.length > 0) {
    // Mirror the single route's closed-enum rule — an unknown id is a
    // contract violation, not a silent drop. The id name is the caller's
    // own input, never user health data, so it is safe to echo.
    annotate({
      action: { name: "insights.derived.batch.invalid-metric" },
      meta: { invalid_count: invalid.length },
    });
    return apiError(
      `Unknown derived metric id(s): ${invalid.join(", ")}`,
      422,
    );
  }
  if (items.length === 0 || items.length > MAX_METRICS) {
    annotate({
      action: { name: "insights.derived.batch.invalid-count" },
      meta: { requested: items.length, max: MAX_METRICS },
    });
    return apiError(
      items.length === 0
        ? "metrics must name at least one registered derived metric"
        : `metrics must name at most ${MAX_METRICS} entries`,
      422,
    );
  }

  // Profile read ONCE — the pool-contention mitigation; the same shared
  // loader the nightly score jobs use, so the batch never re-reads the
  // User row per metric.
  const profile = await loadBaselineProfile(prisma, user.id);

  // Fan out under a bounded limiter so a 17-item dashboard read resolves
  // four computes at a time against the shared pool, not seventeen.
  const limit = pLimit(BATCH_CONCURRENCY);
  const now = new Date();

  // Attach the cheap DETERMINISTIC per-score assessment to the grid read so
  // iOS paints the "Einschätzung" straight off the overview without a second
  // per-id round-trip (the AI-warm prose stays lazy, served by the single
  // route). `resolveDeterministicAssessment` is pure — no DB, no LLM — and
  // null for non-assessable ids / non-`ok` status, so a non-score item still
  // gets `assessment: null`. A best-effort grid extra must NEVER fail the
  // whole batch, so each call is guarded → null on any unexpected shape.
  const locale = await resolveServerLocale({
    request,
    userLocale: user.locale ?? null,
    override: request.nextUrl.searchParams.get("locale"),
  });
  const assessmentLocale = locale === "de" ? "de" : "en";
  const safeAssessment = (
    metric: DerivedMetricId,
    derived: Parameters<typeof resolveDeterministicAssessment>[1],
  ) => {
    try {
      return resolveDeterministicAssessment(
        metric,
        derived,
        assessmentLocale,
        now,
      );
    } catch {
      return null;
    }
  };
  const results = await Promise.all(
    items.map((item) =>
      limit(async () => {
        const derived = await computeDerivedMetric({
          metric: item.metric,
          userId: user.id,
          profile,
          type: item.type,
          now,
        });
        return {
          key: item.key,
          payload: {
            metric: item.metric,
            status: derived.status,
            value: derived.status === "ok" ? derived.value : null,
            coverage: derived.coverage,
            confidence: derived.status === "ok" ? derived.confidence : null,
            provenance: derived.provenance,
            reason:
              derived.status === "insufficient" ? derived.reason : null,
            // Deterministic assessment only (cheap, pure). The AI-warm prose
            // stays a single-route concern; here every assessable `ok` score
            // carries its template "why" text, everything else stays null.
            assessment: safeAssessment(item.metric, derived),
          },
        };
      }),
    ),
  );

  const map: Record<string, (typeof results)[number]["payload"]> = {};
  for (const r of results) map[r.key] = r.payload;

  annotate({
    action: { name: "insights.derived.batch" },
    meta: {
      requested: items.length,
      ok: results.filter((r) => r.payload.status === "ok").length,
    },
  });

  // `metrics` is a map keyed by the per-request token so the client reads
  // back exactly what it asked for (`VITALS_BASELINE:WEIGHT`, `READINESS`).
  return apiSuccess({ metrics: map });
});
