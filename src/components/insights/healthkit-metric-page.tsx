"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { Sparkles } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import {
  useInsightsLayoutPrefs,
  useInsightsRangePref,
} from "@/hooks/use-insights-layout-prefs";
import { useAnalyticsRange } from "@/hooks/use-analytics-range";
import { useTranslations } from "@/lib/i18n/context";
import type { InsightMetric } from "@/lib/insights/metric-availability";
import {
  getMetricStatusMeta,
  metricIdForMeasurementType,
} from "@/lib/insights/metric-status-registry";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import { sentimentFromMetricDirection } from "@/lib/insights/trend-sentiment";
import type { ChartOverlayKey } from "@/lib/dashboard-layout";
import type { MeasurementType } from "@/generated/prisma/client";
import { Button } from "@/components/ui/button";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import { MetricStatusCard } from "@/components/insights/metric-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricStatStrip } from "@/components/insights/metric-stat-strip";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { TimeRangePills } from "@/components/insights/time-range-pills";
import { MetricRangeDelta } from "@/components/insights/metric-range-delta";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.32 — shared scaffold for the wave-A HealthKit metric pages.
 *
 * Each of the five new metric sub-pages (HRV, resting HR, oxygen
 * saturation, body temperature, active energy) shares the same
 * envelope:
 *
 *   1. `<SubPageShell>` with a localised title + description.
 *   2. Empty-state CTA when the user has no observations for the
 *      metric — points at `/measurements?add=<TYPE>` so the existing
 *      quick-entry dialog can light up. The CTA target is optional;
 *      Apple-Health-only metrics (active energy, body temperature)
 *      pass `null` to render an onboarding hint without a dead link.
 *   3. `<HealthChartDynamic>` mounted on the canonical
 *      `ChartOverlayKey` so the chart-cog popover persists per metric.
 *   4. A header-height Coach launch icon (`coachLaunch` on the shell) —
 *      feature-flag gating runs inside the button so this scaffold stays
 *      agnostic.
 *
 * Adding a new metric is a four-line page module that hands the right
 * Zod / MeasurementType + ChartOverlayKey + i18n-key prefix to this
 * component; the template stays single-source-of-truth.
 */

export interface HealthKitMetricPageProps {
  /** The MeasurementType that backs the chart. */
  measurementType: string;
  /** The InsightMetric key used by `useInsightsAnalytics()`. */
  insightMetric: InsightMetric;
  /** The chart-overlay slot id. */
  chartKey: ChartOverlayKey;
  /**
   * i18n key prefix that drives `title`, `description`, `chartTitle`,
   * `emptyState.title`, `emptyState.description`, `emptyState.cta`.
   * Pages pass e.g. `"insights.hrv"` and the scaffold resolves each
   * sub-key off the prefix.
   */
  i18nPrefix: string;
  /** Single canonical colour for the chart line. */
  color: string;
  /** Unit suffix the chart renders next to the value. */
  unit: string;
  /** Optional y-axis label shown above the unit. */
  yAxisUnit?: string;
  /** Optional value bands (Apple-Health-style target zone shading). */
  valueBands?: ComponentProps<typeof HealthChartDynamic>["valueBands"];
  /**
   * Optional empty-state CTA target. `null` renders the empty state
   * without a primary action (Apple-Health-only metrics that have no
   * manual entry form). String values land in `/measurements?add=<x>`.
   */
  emptyStateCtaType?: string | null;
  /** Icon node mounted in the empty-state card. */
  emptyStateIcon: ReactNode;
  /**
   * Optional Coach prefill for the empty-state launch. Falls back to a
   * generic onboarding prompt threaded through `<CoachLaunchButton>`'s
   * default.
   */
  coachPrefill?: string;
  /**
   * v1.7.0 — display-time value scale for the chart (e.g. WALKING_SPEED
   * stores m/s but renders km/h via `valueScale={3.6}`). Defaults to 1
   * (identity) so every existing page renders unchanged.
   */
  valueScale?: number;
  /**
   * v1.8.0 — metric key threaded into `<SubPageShell explainerMetric>`
   * so the `?` heading glyph opens the static "What is X?" explainer.
   * Resolves `insights.subPage.explainer.<explainerMetric>{Title,Body}`.
   */
  explainerMetric?: string;
  /**
   * v1.8.5 W5 — when set, renders `<MetricTargetSummary slug=…>` beneath
   * the chart. Used by blood glucose, whose per-context ADA / DDG bands
   * live on the targets wire but whose page rides this generic scaffold
   * rather than a bespoke module. Omit it for metrics without a target.
   */
  targetSummarySlug?: string;
  /**
   * v1.8.7.1 — when set, mounts `<InsightStatusCard>` beneath the chart,
   * pointed at the generic per-metric assessment route
   * (`/api/insights/metric-status?metric=<statusMetric>`). The value is
   * the HealthKit metric identifier the route keys on — almost always the
   * same string as `measurementType`. The card is only rendered on the
   * data-bearing branch; the empty (insufficient-data) branch keeps the
   * existing `<MetricEmptyState>` note and never fires an assessment
   * fetch. Omit it for metrics that should not carry an assessment.
   *
   * Typed to the closed `MetricStatusMetricId` union (the registry-id
   * vocabulary the route's Zod enum accepts) rather than a bare string,
   * so a page that passes a MeasurementType remap (e.g.
   * `ACTIVE_ENERGY_BURNED` instead of the `ACTIVE_ENERGY` registry id)
   * is a compile error, not a silent 422.
   */
  statusMetric?: MetricStatusMetricId;
}

export function HealthKitMetricPage({
  measurementType,
  insightMetric,
  chartKey,
  i18nPrefix,
  color,
  unit,
  yAxisUnit,
  valueBands,
  emptyStateCtaType,
  emptyStateIcon,
  coachPrefill,
  valueScale,
  explainerMetric,
  targetSummarySlug,
  statusMetric,
}: HealthKitMetricPageProps) {
  const { user, isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);
  const { range, setRange } = useInsightsRangePref();

  const { data: analytics, isEmpty } = useInsightsAnalytics(insightMetric);

  // v1.9.0 — period-over-period range read. Single-metric, additive route;
  // gated off the empty-data branch so a brand-new metric never fires it.
  const { data: rangeData, isLoading: isRangeLoading } = useAnalyticsRange(
    measurementType,
    range,
    !isEmpty,
  );

  // The delta's sentiment colour follows the metric's "good direction" from
  // the metric-status registry (higher-better → up-good, lower-better →
  // up-bad, target-band → neutral). Every HealthKit metric page is backed by
  // a registry entry; a metric absent from the registry falls back to neutral.
  const registryMeta = (() => {
    const id = metricIdForMeasurementType(measurementType as MeasurementType);
    return id ? getMetricStatusMeta(id) : null;
  })();
  const directionSentiment = registryMeta
    ? sentimentFromMetricDirection(registryMeta.direction)
    : "neutral";

  const rawSummary = analytics?.summaries?.[measurementType] ?? null;
  // The stat strip renders display-unit values. The summary holds stored
  // values, so when the page renders a scaled unit (e.g. WALKING_SPEED
  // stores m/s but displays km/h via `valueScale`), fold the same scale
  // into the strip's min / max / median / mean so the numbers and the
  // unit agree. `valueScale` defaults to 1 (identity) → byte-identical
  // for every non-scaled metric.
  const scale = valueScale ?? 1;
  const summary =
    rawSummary && scale !== 1
      ? {
          ...rawSummary,
          min: rawSummary.min === null ? null : rawSummary.min * scale,
          max: rawSummary.max === null ? null : rawSummary.max * scale,
          mean: rawSummary.mean === null ? null : rawSummary.mean * scale,
          median:
            rawSummary.median === null ? null : rawSummary.median * scale,
        }
      : rawSummary;

  const title = t(`${i18nPrefix}.title`);
  const description = t(`${i18nPrefix}.description`);

  if (isEmpty) {
    const ctaNode =
      emptyStateCtaType != null ? (
        <Button size="sm" asChild>
          <Link href={`/measurements?add=${emptyStateCtaType}`}>
            {t(`${i18nPrefix}.emptyState.cta`)}
          </Link>
        </Button>
      ) : null;
    return (
      <SubPageShell
        title={title}
        description={description}
        explainerMetric={explainerMetric}
      >
        <MetricEmptyState
          icon={emptyStateIcon}
          title={t(`${i18nPrefix}.emptyState.title`)}
          description={t(`${i18nPrefix}.emptyState.description`)}
          cta={ctaNode}
          coachPrefill={coachPrefill ?? null}
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={title}
      description={description}
      explainerMetric={explainerMetric}
      statStrip={<MetricStatStrip summary={summary} unit={yAxisUnit ?? unit} />}
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType={measurementType}
          metricLabel={title}
          timeZone={user?.timezone ?? undefined}
        />
      }
      coachLaunch
      showAllValuesType={measurementType}
    >
      {/* v1.9.0 — time-range pills + period-over-period delta, between the
          stat strip and the chart. The selected range persists across metrics
          via `useInsightsRangePref`. */}
      <div
        data-slot="metric-range-controls"
        className="flex flex-wrap items-center justify-between gap-2"
      >
        <TimeRangePills value={range} onChange={setRange} />
        <MetricRangeDelta
          data={rangeData}
          range={range}
          directionSentiment={directionSentiment}
          isLoading={isRangeLoading}
        />
      </div>
      <HealthChartDynamic
        chartKey={chartKey}
        types={[measurementType]}
        title={t(`${i18nPrefix}.chartTitle`)}
        colors={[color]}
        unit={unit}
        yAxisUnit={yAxisUnit}
        valueBands={valueBands}
        compareBaseline={compareBaseline}
        userTimezone={user?.timezone}
        valueScale={valueScale}
      />
      {targetSummarySlug ? (
        <MetricTargetSummary slug={targetSummarySlug} />
      ) : null}
      {statusMetric ? (
        <MetricStatusCard
          metric={statusMetric}
          icon={<Sparkles className="h-5 w-5" />}
          enabled={!isEmpty}
        />
      ) : null}
    </SubPageShell>
  );
}
