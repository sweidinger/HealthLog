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
 * The quality block's "Einschätzung".
 *
 * v1.18.7 W-D — the assessment slot was broken: the previous wiring disabled
 * the status fetch whenever the AI narrative was absent, so the card could not
 * read `hasProvider` and fell back to its `hasProvider: false` default — it
 * showed the "connect an AI provider" CTA even for accounts that HAVE a
 * provider connected (the text just hadn't been generated yet), AND it stacked
 * that CTA under the grounded note. Two assessments, one of them wrong.
 *
 * The card now stays enabled (gated only on the metric having data), so it
 * reports the truthful state from the route:
 *   - no provider          → the route's `hasProvider: false` → the card's own
 *                            clean "connect an AI provider → AI settings" CTA,
 *                            ALONE (the grounded note stands down).
 *   - provider, no text yet → the grounded note fills the slot with a read
 *                            built from the user's own quality averages, so the
 *                            block is never the bare "no assessment yet" line.
 *   - provider, text/prep   → the AI card owns the slot; the grounded note
 *                            stands down so the two never stack.
 *
 * The grounded note reads the SAME SLEEP_SCORE status query the card warmed, so
 * it adds no second round-trip.
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

  // The grounded note only steps in when a provider IS connected but the AI
  // narrative has SETTLED with no text (and none is being assembled). When no
  // provider is configured the AI card owns the slot with its own CTA, so the
  // note never stacks under it; when the AI text exists or is preparing the AI
  // card wins. Until the status query settles we show nothing extra, so the
  // note never flashes ahead of a warm AI assessment.
  const showGroundedNote =
    hasSleepScore &&
    status?.hasProvider === true &&
    !statusLoading &&
    !status?.text &&
    status?.preparing !== true &&
    status?.revalidating !== true;

  // Exactly one block fills the assessment slot, so the two never stack: the
  // grounded note when a provider is connected but the AI text has settled
  // empty, otherwise the status card (which owns the no-provider CTA, the
  // preparing state, and the real text). The card's hook fetched regardless of
  // which branch renders — it runs at the top of this component — so swapping
  // its render for the note loses no `hasProvider` knowledge.
  if (showGroundedNote) {
    return <SleepQualityGroundedNote summaries={summaries} showWhenAiAbsent />;
  }

  return (
    <MetricStatusCard
      metric="SLEEP_SCORE"
      icon={<Moon className="h-5 w-5" />}
      enabled={hasSleepScore}
    />
  );
}
