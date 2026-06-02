"use client";

import { useParams } from "next/navigation";

import { useTranslations } from "@/lib/i18n/context";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import {
  CompositeScoreAnatomy,
  type CompositeMetricId,
} from "@/components/insights/derived/composite-score-anatomy";

/**
 * v1.10.0 — `/insights/scores/<metric>` — the composite score-anatomy
 * detail surface.
 *
 * Reached on tap from a composite's dashboard / insights entry. Renders the
 * Oura-style anatomy view (big ring + ranked contributor rows + cited
 * standard) for one composite. The `[metric]` param is validated against the
 * two W3 composites — an unknown slug falls back to the readiness view's
 * insufficient state rather than 404-ing, so a stale link never dead-ends.
 */

const SLUG_TO_METRIC: Record<string, CompositeMetricId> = {
  sleep: "SLEEP_SCORE",
  readiness: "READINESS",
};

export default function CompositeScorePage() {
  const params = useParams<{ metric: string }>();
  const { t } = useTranslations();
  const slug = typeof params.metric === "string" ? params.metric : "";
  const metric: CompositeMetricId = SLUG_TO_METRIC[slug] ?? "READINESS";

  return (
    <SubPageShell
      title={t(`insights.derived.composite.${metric}.title`)}
      description={t(`insights.derived.composite.${metric}.description`)}
      coachLaunch
    >
      <CompositeScoreAnatomy metric={metric} />
    </SubPageShell>
  );
}
