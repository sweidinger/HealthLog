"use client";

import type { ReactNode } from "react";

import { useInsightMetricStatus } from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import type { MetricStatusMetricId } from "@/lib/insights/metric-status-registry";
import { InsightStatusCard } from "@/components/insights/insight-status-card";

interface MetricStatusCardProps {
  /** The registry metric id the generic assessment route keys on. */
  metric: MetricStatusMetricId;
  /** The leading glyph (Sparkles for the generic scaffold, Moon for sleep). */
  icon: ReactNode;
  /**
   * Gate the fetch on the page having data, so an insufficient-data page
   * never fires an assessment round-trip. The hook still runs on every
   * render (rules of hooks); `enabled` decides whether it talks to the
   * network.
   */
  enabled: boolean;
}

/**
 * v1.8.7.1 — shared mount for the generic per-metric assessment card.
 *
 * Owns the `useInsightMetricStatus` hook + the eight-prop `<InsightStatusCard>`
 * wiring (`status?.x ?? default`) so the HealthKit metric scaffold and the
 * bespoke sleep page consume one seam instead of repeating the block. Only
 * the icon differs between the two sites; everything else is identical.
 */
export function MetricStatusCard({
  metric,
  icon,
  enabled,
}: MetricStatusCardProps) {
  const { t } = useTranslations();
  const { data: status, isLoading } = useInsightMetricStatus(metric, enabled);

  return (
    <InsightStatusCard
      title={t("insights.assessmentTitle")}
      icon={icon}
      text={status?.text ?? null}
      hasProvider={status?.hasProvider ?? false}
      updatedAt={status?.updatedAt ?? null}
      loading={isLoading}
      preparing={status?.preparing ?? false}
    />
  );
}
