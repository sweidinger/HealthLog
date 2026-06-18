"use client";

import { Activity, Gauge, Moon, Repeat, Target, Waves } from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useInsightMetricStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";
import { SectionHeading } from "@/components/insights/section-heading";
import { DeviceScoreTile } from "@/components/insights/device-score-tile";
import { DeviceScoreGridSkeleton } from "@/components/insights/device-score-tile-skeleton";
import { MetricStatusCard } from "@/components/insights/metric-status-card";
import { SleepQualityGroundedNote } from "@/components/insights/sleep/sleep-quality-grounded-note";

/**
 * v1.17.1 — "Sleep quality" block on `/insights/sleep`.
 *
 * Surfaces the WHOOP / Oura nightly sleep-quality scores that were ingested
 * end-to-end but rendered nowhere: efficiency, performance, consistency, need,
 * disturbance count, and the Oura headline sleep score. Each tile is gated on
 * the metric having data (`<DeviceScoreTile>` returns null at count 0), so a
 * non-wearable user never sees an empty card and the whole section collapses
 * when none of the six has readings.
 *
 * Reads the shared `["analytics", "summaries"]` slice — the same cache the
 * page's duration gate already populated, so this adds no network round-trip.
 * Server-authoritative: the tiles render the stored values, never a recompute.
 */
export function SleepQualitySection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslations();
  const { data, isLoading } = useInsightsAnalytics("SLEEP_DURATION");

  if (!enabled) return null;

  const summaries = data?.summaries;

  // While the shared slice loads, paint the tile-shaped Skeleton grid (same
  // primitive the recovery + labs surfaces use) rather than nothing, so the
  // section does not pop in. Once data lands the section either renders its
  // present tiles or collapses to null — an in-page sub-section never shows a
  // standalone empty card (the page-level empties on /insights/recovery and
  // /labs own that treatment via <EmptyState>).
  if (isLoading || !summaries) {
    return (
      <section data-slot="sleep-quality-loading" className="space-y-3">
        <SectionHeading icon={Moon} title={t("insights.sleepQuality.title")} />
        <DeviceScoreGridSkeleton count={2} />
      </section>
    );
  }

  const tiles: Array<{
    type: string;
    title: string;
    icon: typeof Moon;
    color: string;
    unit?: string;
  }> = [
    {
      type: "SLEEP_SCORE",
      title: t("measurements.typeSleepScore"),
      icon: Moon,
      color: "#bd93f9",
      unit: t("insights.deviceScore.unitScore"),
    },
    {
      type: "SLEEP_PERFORMANCE",
      title: t("measurements.typeSleepPerformance"),
      icon: Target,
      color: "#8be9fd",
      unit: "%",
    },
    {
      type: "SLEEP_EFFICIENCY",
      title: t("measurements.typeSleepEfficiency"),
      icon: Gauge,
      color: "#50fa7b",
      unit: "%",
    },
    {
      type: "SLEEP_CONSISTENCY",
      title: t("measurements.typeSleepConsistency"),
      icon: Repeat,
      color: "#f1fa8c",
      unit: "%",
    },
    {
      type: "SLEEP_NEED",
      title: t("measurements.typeSleepNeed"),
      icon: Waves,
      color: "#ffb86c",
      unit: t("insights.deviceScore.unitMinutes"),
    },
    {
      type: "SLEEP_DISTURBANCE_COUNT",
      title: t("measurements.typeSleepDisturbanceCount"),
      icon: Activity,
      color: "#ff79c6",
    },
  ];

  const present = tiles.filter(
    (tile) => (summaries[tile.type]?.count ?? 0) > 0,
  );
  if (present.length === 0) return null;

  return (
    <section data-slot="sleep-quality-section" className="space-y-3">
      <SectionHeading
        icon={Moon}
        title={t("insights.sleepQuality.title")}
        action={
          <p className="text-muted-foreground text-xs">
            {t("insights.sleepQuality.subtitle")}
          </p>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {present.map((tile) => (
          <DeviceScoreTile
            key={tile.type}
            type={tile.type}
            summary={summaries[tile.type]}
            title={tile.title}
            icon={tile.icon}
            color={tile.color}
            unit={tile.unit}
          />
        ))}
      </div>
      <SleepQualityAssessmentBlock summaries={summaries} />
    </section>
  );
}

/**
 * The quality block's "Einschätzung". The richer AI narrative wins when it
 * exists; until then (or forever, on an account with no AI provider) a
 * deterministic note grounded in the user's own quality averages fills the
 * slot, so the assessment is never the bare "no analysis yet" line.
 *
 * Both reads are gated on the headline sleep score having data — the same gate
 * the AI route used — so the assessment only surfaces with a quality series to
 * describe. The grounded note reads the SLEEP_SCORE status query (already
 * warmed by `<MetricStatusCard>`) to know whether the AI text is absent, so it
 * adds no second round-trip and the two never stack.
 */
function SleepQualityAssessmentBlock({
  summaries,
}: {
  summaries: Record<string, DataSummary | undefined>;
}) {
  const hasSleepScore = (summaries.SLEEP_SCORE?.count ?? 0) > 0;
  const { data: status, isLoading: statusLoading } = useInsightMetricStatus(
    "SLEEP_SCORE",
    hasSleepScore,
  );

  // The AI narrative is "present" when there is text OR the worker is actively
  // assembling one (preparing / revalidating). In those cases the AI card owns
  // the slot. The grounded note only steps in once the status query has SETTLED
  // with no narrative — so it never flashes ahead of a warm AI assessment.
  const aiAbsent =
    !statusLoading &&
    !status?.text &&
    status?.preparing !== true &&
    status?.revalidating !== true;

  return (
    <>
      <MetricStatusCard
        metric="SLEEP_SCORE"
        icon={<Moon className="h-5 w-5" />}
        // Suppress the AI card's static "no analysis yet" / "no provider"
        // empty states — the grounded note covers that ground with real
        // content. The AI card still renders its text / preparing states.
        enabled={hasSleepScore && !aiAbsent}
      />
      <SleepQualityGroundedNote
        summaries={summaries}
        showWhenAiAbsent={hasSleepScore && aiAbsent}
      />
    </>
  );
}
