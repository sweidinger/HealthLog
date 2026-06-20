/**
 * `GET /api/illness/insights?windowDays=365` — the cross-episode retrospective
 * summary: "sick N times this year · typical recovery gap X days", with a
 * recurrence-by-month tally and a per-type breakdown.
 *
 * RETROSPECTIVE ONLY — it summarises past episodes. It is NEVER a predictor or
 * diagnoser; the recurrence figure is a count, not a forecast. Server-
 * authoritative + gated: the "typical gap" is withheld below the signal-
 * density floor (asserts nothing thin). Per-episode gaps come from the same
 * coverage-gated correlation engine the per-episode route uses, so a thin
 * episode contributes no gap rather than a wrong one. Born-gated + owner-
 * scoped.
 *
 * LAZY BY DEFAULT — the recovery-gap is the only expensive part (a bounded
 * per-episode correlation fan-out). The illness LIST loads with
 * `includeRecoveryGap` unset, so it pays only for a single count query and
 * paints fast; the gap is computed solely when the user opens the explicit
 * "Analyse" expansion (`includeRecoveryGap=true`). With it off the summary
 * returns the count breakdown and a null typical-gap.
 */
import { NextRequest } from "next/server";
import pLimit from "p-limit";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { illnessInsightsQuerySchema } from "@/lib/validations/illness";
import { computeEpisodeCorrelation } from "@/lib/illness/correlation-read";
import {
  summarizeIllnessRetrospective,
  type RetrospectiveEpisode,
} from "@/lib/illness/retrospective";
import { dayKeyForUserTz } from "@/lib/measurements/consolidation-tz";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Cap the per-episode gap computations so a heavy history can't fan out. */
const MAX_GAP_COMPUTATIONS = 24;
/** Run the per-episode correlations under a bounded concurrency budget so
 *  the up-to-24 candidates don't serialise into ~500 round-trips. */
const EPISODE_GAP_CONCURRENCY = 4;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const params = new URL(request.url).searchParams;
  const parsed = illnessInsightsQuerySchema.safeParse({
    windowDays: params.get("windowDays") ?? undefined,
    includeRecoveryGap: params.get("includeRecoveryGap") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "illness.insights.invalid",
    });
  }

  const windowDays = parsed.data.windowDays ?? 365;
  const includeRecoveryGap = parsed.data.includeRecoveryGap ?? false;
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const tz = resolveUserTimezone(user.timezone ?? null);

  const rows = await prisma.illnessEpisode.findMany({
    where: { userId: user.id, deletedAt: null, onsetAt: { gte: since } },
    orderBy: { onsetAt: "desc" },
    select: {
      id: true,
      type: true,
      lifecycle: true,
      onsetAt: true,
      resolvedAt: true,
    },
  });

  // The recovery-gap is the only expensive part. LIST loads skip it
  // entirely (`includeRecoveryGap` off) so the page paints on the single
  // `findMany` above; the explicit "Analyse" expansion turns it on and pays
  // the bounded fan-out. Per-episode gap + coverage come from the coverage-
  // gated engine — a thin episode yields null/low coverage and is filtered
  // out of the typical-gap median by the aggregate's signal-density gates.
  const gapById = new Map<
    string,
    { recoveryGapDays: number | null; gapMeasurementDays: number }
  >();
  if (includeRecoveryGap) {
    const gapCandidates = rows
      .filter((r) => r.resolvedAt !== null && r.lifecycle !== "CHRONIC_ONGOING")
      .slice(0, MAX_GAP_COMPUTATIONS);
    const limit = pLimit(EPISODE_GAP_CONCURRENCY);
    const gapEntries = await Promise.all(
      gapCandidates.map((r) =>
        limit(
          async (): Promise<
            [
              string,
              { recoveryGapDays: number | null; gapMeasurementDays: number },
            ]
          > => {
            const derived = await computeEpisodeCorrelation(
              user.id,
              {
                id: r.id,
                onsetAt: r.onsetAt,
                resolvedAt: r.resolvedAt,
                lifecycle: r.lifecycle,
              },
              tz,
              now,
            );
            return [
              r.id,
              {
                recoveryGapDays:
                  derived.status === "ok"
                    ? derived.value.recoveryGapDays
                    : null,
                // `historyDays` = distinct episode days with a banded vital,
                // present on both the `ok` and `insufficient` arms.
                gapMeasurementDays: derived.coverage.historyDays,
              },
            ];
          },
        ),
      ),
    );
    for (const [id, entry] of gapEntries) gapById.set(id, entry);
  }

  const episodes: RetrospectiveEpisode[] = rows.map((r) => {
    const gap = gapById.get(r.id);
    return {
      id: r.id,
      type: r.type,
      onsetDay: dayKeyForUserTz(r.onsetAt, tz),
      resolved: r.resolvedAt !== null,
      recoveryGapDays: gap?.recoveryGapDays ?? null,
      gapMeasurementDays: gap?.gapMeasurementDays ?? 0,
      lifecycle: r.lifecycle,
    };
  });

  const summary = summarizeIllnessRetrospective(episodes);

  annotate({
    action: { name: "illness.insights.read", entity_type: "illness_episode" },
    meta: {
      episode_count: summary.episodeCount,
      gap_sample_size: summary.gapSampleSize,
      typical_gap_days: summary.typicalRecoveryGapDays,
      include_recovery_gap: includeRecoveryGap,
    },
  });

  return apiSuccess({ windowDays, ...summary });
});
