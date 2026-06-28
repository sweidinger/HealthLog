"use client";

import { Scaling } from "lucide-react";

import { HealthKitMetricPage } from "@/components/insights/healthkit-metric-page";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.25 — `/insights/waist-to-height`.
 *
 * Waist-to-height ratio sub-page. The ancestry-robust single number (NICE:
 * keep waist under half your height — WHtR ≥ 0.5 flags increased risk). Rides
 * the generic metric template for its detail spine + assessment.
 */
export default function InsightsWaistToHeightPage() {
  const { t } = useTranslations();
  return (
    <HealthKitMetricPage
      measurementType="WAIST_TO_HEIGHT"
      statusMetric="WAIST_TO_HEIGHT"
      insightMetric="WAIST_TO_HEIGHT"
      chartKey="waistToHeight"
      i18nPrefix="insights.waistToHeight"
      color="#8b5cf6"
      unit=""
      statIcon={Scaling}
      emptyStateIcon={<Scaling className="size-6" />}
      emptyStateCtaType="WAIST_TO_HEIGHT"
      coachPrefill={t("insights.waistToHeight.coachPrefill")}
    />
  );
}
