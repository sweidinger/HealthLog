"use client";

import { useTranslations } from "@/lib/i18n/context";
import { useDerivedMetric } from "@/hooks/use-derived-metric";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  ReadinessValue,
  SleepScoreValue,
} from "@/lib/insights/derived";
import {
  ScoreAnatomyView,
  type AnatomyContributor,
} from "./score-anatomy-view";
import type { ProvenanceStandard } from "./provenance-explainer";

/**
 * v1.10.0 — the data-bound wrapper that fetches a composite derived metric
 * and renders the reusable `ScoreAnatomyView`. It owns the per-metric
 * presentation map (title, contributor labels, the cited standard, the
 * plain-language method) so the anatomy view itself stays metric-agnostic.
 *
 * Supports the W3 composites: `SLEEP_SCORE` and `READINESS`. Each maps its
 * `value` (sub-scores / components) onto the normalised `AnatomyContributor`
 * list and supplies its cited standard + method copy from the i18n bundle.
 *
 * Client-only: `import type` for the value shapes (no server graph leaks);
 * the fetch rides the same `/api/insights/derived` route + 8 s client
 * ceiling as the rest of the surface.
 */

export type CompositeMetricId = "SLEEP_SCORE" | "READINESS";

/** The cited standard per composite (the explainer's external link). */
const STANDARDS: Record<CompositeMetricId, ProvenanceStandard> = {
  SLEEP_SCORE: {
    name: "Hirshkowitz et al. 2015, Sleep Health",
    url: "https://doi.org/10.1016/j.sleh.2014.12.010",
  },
  READINESS: {
    name: "Plews et al. 2013, Sports Medicine",
    url: "https://doi.org/10.1007/s40279-013-0071-8",
  },
};

export interface CompositeScoreAnatomyProps {
  metric: CompositeMetricId;
  className?: string;
}

export function CompositeScoreAnatomy({
  metric,
  className,
}: CompositeScoreAnatomyProps) {
  const { t } = useTranslations();

  const sleep = useDerivedMetric<SleepScoreValue>("SLEEP_SCORE", {
    enabled: metric === "SLEEP_SCORE",
  });
  const readiness = useDerivedMetric<ReadinessValue>("READINESS", {
    enabled: metric === "READINESS",
  });

  const query = metric === "SLEEP_SCORE" ? sleep : readiness;

  if (query.isLoading) {
    return (
      <div data-slot="composite-anatomy-loading" className={className}>
        <Skeleton className="h-[28rem] w-full rounded-xl" />
      </div>
    );
  }

  const data = query.data;
  const title = t(`insights.derived.composite.${metric}.title`);
  const standard = STANDARDS[metric];

  if (!data) {
    // Network/abort fallback — render the insufficient state honestly.
    return (
      <ScoreAnatomyView
        title={title}
        score={null}
        contributors={[]}
        coverage={{
          requiredInputs: 1,
          presentInputs: 0,
          historyDays: 0,
          missing: [],
        }}
        confidence={null}
        provenance={{
          inputs: [],
          source: "none",
          windowDays: 0,
          computedAt: new Date().toISOString(),
        }}
        method={t(`insights.derived.composite.${metric}.method`)}
        standard={standard}
        insufficient
        className={className}
      />
    );
  }

  const insufficient = data.status !== "ok";
  let score: number | null = null;
  let contributors: AnatomyContributor[] = [];
  let caption: string | undefined;

  if (data.status === "ok" && data.value) {
    if (metric === "SLEEP_SCORE") {
      const v = data.value as SleepScoreValue;
      score = v.score;
      caption = t(`insights.derived.scoreRing.band.${v.band}`);
      contributors = v.subScores
        .map((s) => ({
          key: s.key,
          label: t(`insights.derived.composite.SLEEP_SCORE.sub.${s.key}`),
          value: s.value,
          weight: s.weight,
        }))
        .sort(rankByImpact);
    } else {
      const v = data.value as ReadinessValue;
      score = v.score;
      caption = t(`insights.derived.scoreRing.band.${v.band}`);
      contributors = v.components
        .map((c) => ({
          key: c.key,
          label: t(`insights.derived.composite.READINESS.component.${c.key}`),
          value: c.value,
          weight: c.weight,
        }))
        .sort(rankByImpact);
    }
  }

  return (
    <ScoreAnatomyView
      title={title}
      score={score}
      caption={caption}
      contributors={contributors}
      coverage={data.coverage}
      confidence={data.confidence}
      provenance={data.provenance}
      method={t(`insights.derived.composite.${metric}.method`)}
      standard={standard}
      insufficient={insufficient}
      className={className}
    />
  );
}

/** Rank contributors by impact: present-and-higher-weight first. */
function rankByImpact(a: AnatomyContributor, b: AnatomyContributor): number {
  const aPresent = a.value != null ? 1 : 0;
  const bPresent = b.value != null ? 1 : 0;
  if (aPresent !== bPresent) return bPresent - aPresent;
  return b.weight - a.weight;
}
