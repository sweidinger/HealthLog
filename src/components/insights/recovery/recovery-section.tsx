"use client";

import {
  Activity,
  Battery,
  Flame,
  Gauge,
  Heart,
  HeartPulse,
  TrendingUp,
} from "lucide-react";

import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useTranslations } from "@/lib/i18n/context";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeading } from "@/components/insights/section-heading";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { RestModeBanner } from "@/components/insights/rest-mode-banner";
import type { RestModeAnnotation } from "@/lib/analytics/health-score";
import type { ChartOverlayKey } from "@/lib/dashboard-layout";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import { RecoveryMetricBlock } from "@/components/insights/recovery/recovery-metric-block";

interface BlockSpec {
  type: string;
  chartKey: ChartOverlayKey;
  statusMetric: MetricStatusMetricId;
  title: string;
  explainer: string;
  icon: typeof Activity;
  color: string;
  unit: string;
  fractionDigits?: number;
}

interface BlockGroup {
  key: string;
  headingIcon: typeof Activity;
  title: string;
  subtitle: string;
  blocks: BlockSpec[];
}

/**
 * v1.17.1 → rebuilt v1.18.1 (B1–B3) — body of the `/insights/recovery`
 * sub-page.
 *
 * The page now reads exactly like every other metric page: each present
 * device-native signal (WHOOP / Polar / Oura recharge, strain, load, and
 * whole-day cardiac / energy figures) renders as a canonical block — a
 * short explanatory line, the max / median / mean stat strip, the same
 * `<HealthChartDynamic>` chart with the identical 7 / 30 / 90 / All toggle,
 * and a per-chart AI assessment (`<MetricStatusCard>`). The composite
 * RECOVERY_SCORE keeps its anatomy view at `/insights/scores/recovery`.
 *
 * B3 — the redundant "Recovery score" link block that used to lead the
 * page is gone: this surface is reached from the overview already, so the
 * cross-link was duplicate ("doppelt gemoppelt").
 *
 * Each block is data-gated (a signal with zero readings is dropped) and a
 * group with no present block hides entirely, so a non-wearable account
 * sees only the calm empty note. Reads the shared analytics summaries slice
 * (no extra round-trip); server-authoritative throughout.
 */
export function RecoverySection() {
  const { t } = useTranslations();
  const { data, isLoading } = useInsightsAnalytics("SLEEP_DURATION");
  // v1.18.1 — Rest Mode parity. The annotation rides the thick analytics
  // payload's `healthScore` block (server-authoritative; iOS mirrors it). We
  // read it off the same `["analytics"]` cache the insights mother page
  // primes, so navigating in is a free hit and a direct URL load pays one
  // thick fetch. Read-only — the score itself stays untouched.
  const analyticsQuery = useAnalyticsQuery();
  const restMode =
    ((analyticsQuery.data?.healthScore as { restMode?: RestModeAnnotation } | null)
      ?.restMode ?? null) as RestModeAnnotation | null;

  const summaries = data?.summaries;
  const unitScore = t("insights.deviceScore.unitScore");
  const unitBpm = t("insights.deviceScore.unitBpm");
  const unitKj = t("insights.deviceScore.unitKj");

  const groups: BlockGroup[] = [
    {
      key: "recharge",
      headingIcon: Battery,
      title: t("insights.recovery.recharge.title"),
      subtitle: t("insights.recovery.recharge.subtitle"),
      blocks: [
        {
          type: "ANS_CHARGE",
          chartKey: "ansCharge",
          statusMetric: "ANS_CHARGE",
          title: t("measurements.typeAnsCharge"),
          explainer: t("insights.recovery.block.ansChargeExplainer"),
          icon: Battery,
          color: "#50fa7b",
          unit: unitScore,
          fractionDigits: 1,
        },
      ],
    },
    {
      key: "strain",
      headingIcon: Gauge,
      title: t("insights.recovery.strain.title"),
      subtitle: t("insights.recovery.strain.subtitle"),
      blocks: [
        {
          type: "DAY_STRAIN",
          chartKey: "dayStrain",
          statusMetric: "DAY_STRAIN",
          title: t("measurements.typeDayStrain"),
          explainer: t("insights.recovery.block.dayStrainExplainer"),
          icon: Gauge,
          color: "#ffb86c",
          unit: unitScore,
          fractionDigits: 1,
        },
        {
          type: "WORKOUT_STRAIN",
          chartKey: "workoutStrain",
          statusMetric: "WORKOUT_STRAIN",
          title: t("measurements.typeWorkoutStrain"),
          explainer: t("insights.recovery.block.workoutStrainExplainer"),
          icon: Activity,
          color: "#ff79c6",
          unit: unitScore,
          fractionDigits: 1,
        },
        {
          type: "CARDIO_LOAD",
          chartKey: "cardioLoad",
          statusMetric: "CARDIO_LOAD",
          title: t("measurements.typeCardioLoad"),
          explainer: t("insights.recovery.block.cardioLoadExplainer"),
          icon: TrendingUp,
          color: "#bd93f9",
          unit: unitScore,
        },
      ],
    },
    {
      key: "cardio",
      headingIcon: HeartPulse,
      title: t("insights.recovery.cardio.title"),
      subtitle: t("insights.recovery.cardio.subtitle"),
      blocks: [
        {
          type: "AVERAGE_HEART_RATE",
          chartKey: "averageHeartRate",
          statusMetric: "AVERAGE_HEART_RATE",
          title: t("measurements.typeAverageHeartRate"),
          explainer: t("insights.recovery.block.averageHeartRateExplainer"),
          icon: Heart,
          color: "#8be9fd",
          unit: unitBpm,
        },
        {
          type: "MAX_HEART_RATE",
          chartKey: "maxHeartRate",
          statusMetric: "MAX_HEART_RATE",
          title: t("measurements.typeMaxHeartRate"),
          explainer: t("insights.recovery.block.maxHeartRateExplainer"),
          icon: HeartPulse,
          color: "#ff5555",
          unit: unitBpm,
        },
        {
          type: "ENERGY_EXPENDITURE_KJ",
          chartKey: "energyExpenditureKj",
          statusMetric: "ENERGY_EXPENDITURE_KJ",
          title: t("measurements.typeEnergyExpenditureKj"),
          explainer: t("insights.recovery.block.energyExpenditureKjExplainer"),
          icon: Flame,
          color: "#f1fa8c",
          unit: unitKj,
        },
      ],
    },
  ];

  const hasAny =
    summaries != null &&
    groups.some((group) =>
      group.blocks.some((block) => (summaries[block.type]?.count ?? 0) > 0),
    );

  if (isLoading || summaries == null) {
    return (
      <div className="space-y-3" data-slot="recovery-loading">
        <SectionHeading
          icon={Battery}
          title={t("insights.recovery.recharge.title")}
        />
        <ChartSkeleton />
      </div>
    );
  }

  if (!hasAny) {
    return (
      <EmptyState
        data-slot="recovery-empty"
        icon={<Heart className="size-6" />}
        title={t("insights.recovery.emptyTitle")}
        description={t("insights.recovery.empty")}
      />
    );
  }

  return (
    <div className="space-y-8" data-slot="recovery-section">
      {/* v1.18.1 — calm Rest Mode cue at the head of the recovery surface.
          Self-gating: renders nothing unless an episode is active. */}
      <RestModeBanner annotation={restMode} />
      {groups.map((group) => {
        const present = group.blocks.filter(
          (block) => (summaries[block.type]?.count ?? 0) > 0,
        );
        if (present.length === 0) return null;
        return (
          <section
            key={group.key}
            data-slot={`recovery-group-${group.key}`}
            className="space-y-4"
          >
            <SectionHeading
              icon={group.headingIcon}
              title={group.title}
              action={
                <p className="text-muted-foreground text-xs">
                  {group.subtitle}
                </p>
              }
            />
            <div className="space-y-8">
              {present.map((block) => (
                <RecoveryMetricBlock
                  key={block.type}
                  type={block.type}
                  chartKey={block.chartKey}
                  statusMetric={block.statusMetric}
                  title={block.title}
                  explainer={block.explainer}
                  icon={block.icon}
                  color={block.color}
                  unit={block.unit}
                  summary={summaries[block.type] ?? null}
                  fractionDigits={block.fractionDigits}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
