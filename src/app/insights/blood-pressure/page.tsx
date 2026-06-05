"use client";

import Link from "next/link";
import { HeartPulse } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricLastMeasurementCard } from "@/components/insights/metric-last-measurement-card";
import { MetricRangeControls } from "@/components/insights/metric-range-controls";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { getBpTargets } from "@/lib/analytics/bp-targets";

/**
 * v1.4.25 W4 — `/insights/blood-pressure`.
 *
 * Routed Blood-Pressure sub-page. The mother page hosts the overview
 * (hero + briefing + advisor); this page concentrates on BP-only depth:
 * the BP chart with its chart-cog overlays, the per-section AI
 * assessment, and the chart's target zones tied to the user's age.
 *
 * v1.4.27 F17 — when the user has zero BP observations, the page
 * short-circuits to an empty-state CTA pointing at
 * `/measurements?add=BLOOD_PRESSURE`. Apple Health convention: empty
 * surfaces lead to onboarding hints rather than chart skeletons.
 * v1.4.27 MB6 — the previous `/measurements/new` href hit a 404; the
 * measurements page now consumes `?add=<TYPE>` and auto-opens the
 * dialog with the matching default type.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — the analytics fetch and the
 * empty-state render were lifted into `useInsightsAnalytics()` and
 * `<MetricEmptyState>`; the page module is now Apple-Health-lean.
 */
export default function InsightsBlutdruckPage() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(user != null);

  const { data: analytics, isEmpty } =
    useInsightsAnalytics("BLOOD_PRESSURE_SYS");
  const bpLastSeenAt =
    analytics?.lastSeenByType?.BLOOD_PRESSURE_SYS?.lastSeenAt ?? null;

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.bloodPressureSectionTitle")}
        description={t("insights.subPage.blutdruckDescription")}
        explainerMetric="bloodPressure"
      >
        <MetricEmptyState
          icon={<HeartPulse className="size-6" />}
          title={t("insights.emptyState.bloodPressure.title")}
          description={t("insights.emptyState.bloodPressure.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/measurements?add=BLOOD_PRESSURE">
                {t("insights.emptyState.bloodPressure.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I haven't recorded any blood pressure yet — why does it matter, and what should I know before I start?"
        />
      </SubPageShell>
    );
  }

  const bpTargets =
    user?.dateOfBirth != null ? getBpTargets(new Date(user.dateOfBirth)) : null;
  const bpTargetZones = bpTargets
    ? [
        {
          min: bpTargets.sysLow,
          max: bpTargets.sysHigh,
          color: "#ff79c6",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "#ff79c6",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "#8be9fd",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "#8be9fd",
          lineOpacity: 0.24,
        },
      ]
    : undefined;

  return (
    <SubPageShell
      title={t("insights.bloodPressureSectionTitle")}
      description={t("insights.subPage.blutdruckDescription")}
      explainerMetric="bloodPressure"
      coachLaunch
      primary={
        <>
          {/* Blood pressure's primary tile IS its richer target panel
              (ESH classification + sys/dia band + 30-day S/D average),
              promoted above the chart per the canonical spine. */}
          <MetricTargetSummary slug="blood-pressure" />
          <MetricLastMeasurementCard lastSeenAt={bpLastSeenAt} />
        </>
      }
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="BLOOD_PRESSURE_SYS"
          metricLabel={t("insights.bloodPressureSectionTitle")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      showAllValuesType="BLOOD_PRESSURE_SYS"
      /* No `statStrip`: `<MetricStatStrip>` is single-series, but blood
         pressure is two series (systolic + diastolic). A single min / max /
         median / mean strip would silently drop the diastolic half, so the
         page omits it rather than mislead. */
    >
      {/* The period-over-period delta keys on the systolic series — the
          canonical BP figure the targets + status surfaces lead with. */}
      <HealthChartDynamic
        chartKey="bp"
        types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
        title={t("charts.bloodPressure")}
        colors={["#ff79c6", "#8be9fd"]}
        unit="mmHg"
        yAxisUnit="mmHg"
        targetZones={bpTargetZones}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
      />
      {/* v1.12.0 — range pills + period-over-period delta below the chart. */}
      <MetricRangeControls measurementType="BLOOD_PRESSURE_SYS" enabled={!isEmpty} />

      {/* v1.12.0 — Einschätzung is the last block on the canonical
          metric-detail spine. */}
      <SlugInsightStatusCard
        slug="blood-pressure"
        icon={<HeartPulse className="h-5 w-5" />}
      />
    </SubPageShell>
  );
}
