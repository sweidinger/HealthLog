"use client";

import Link from "next/link";
import { Scale } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { MetricPrimaryTile } from "@/components/insights/metric-primary-tile";
import { MetricLastMeasurementCard } from "@/components/insights/metric-last-measurement-card";
import { MetricCorrelationCard } from "@/components/insights/metric-correlation-card";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricRangeControls } from "@/components/insights/metric-range-controls";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { TrajectoryForecastCard } from "@/components/insights/derived/trajectory-forecast-card";
import { buildWeightBandsFromHeight } from "@/lib/analytics/value-bands";

/**
 * v1.4.25 W4 — `/insights/weight`.
 *
 * Routed Weight sub-page. Renders the weight chart with the user's
 * height-derived green/orange/red bands plus the per-section AI
 * assessment. The chart-cog (`chartKey="weight"`) lets the user toggle
 * trend lines + comparison overlay independently from the dashboard
 * weight card.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * branch now consume `useInsightsAnalytics()` + `<MetricEmptyState>`.
 */
export default function InsightsGewichtPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  const { data: analytics, isEmpty } = useInsightsAnalytics("WEIGHT");
  const weightSummary = analytics?.summaries?.WEIGHT ?? null;
  const weightLastSeenAt =
    analytics?.lastSeenByType?.WEIGHT?.lastSeenAt ?? null;

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.weightSectionTitle")}
        description={t("insights.subPage.gewichtDescription")}
        explainerMetric="weight"
      >
        <MetricEmptyState
          icon={<Scale className="size-6" />}
          title={t("insights.emptyState.weight.title")}
          description={t("insights.emptyState.weight.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=WEIGHT">
                {t("insights.emptyState.weight.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any weight yet — why does it matter, and what should I know before I start tracking?"
        />
      </SubPageShell>
    );
  }

  const weightBands = user?.heightCm
    ? buildWeightBandsFromHeight(user.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : undefined;

  return (
    <SubPageShell
      title={t("insights.weightSectionTitle")}
      description={t("insights.subPage.gewichtDescription")}
      explainerMetric="weight"
      primary={
        <>
          <MetricPrimaryTile summary={weightSummary} unit="kg" slug="weight" />
          <MetricLastMeasurementCard lastSeenAt={weightLastSeenAt} />
        </>
      }
      statStrip={<MetricStatStrip summary={weightSummary} unit="kg" />}
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="WEIGHT"
          metricLabel={t("insights.weightSectionTitle")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      coachLaunch
      showAllValuesType="WEIGHT"
    >
      <HealthChartDynamic
        chartKey="weight"
        types={["WEIGHT"]}
        title={t("charts.weight")}
        colors={["#bd93f9"]}
        unit="kg"
        valueBands={weightBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />
      {/* v1.12.0 — range pills + period-over-period delta below the chart. */}
      <MetricRangeControls measurementType="WEIGHT" enabled={!isEmpty} />

      <MetricTargetSummary slug="weight" />

      <TrajectoryForecastCard
        type="WEIGHT"
        unit="kg"
        color="#bd93f9"
        enabled={!isEmpty}
        compact
      />

      {/* v1.12.0 — Weight owns the weight × weekday correlation (relocated
          off the overview onto its metric page). */}
      <MetricCorrelationCard slug="weight" />

      <SlugInsightStatusCard slug="weight" icon={<Scale className="h-5 w-5" />} />
    </SubPageShell>
  );
}
