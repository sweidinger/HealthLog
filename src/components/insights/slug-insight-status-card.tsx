"use client";

import type { ReactNode } from "react";

import {
  useInsightStatus,
  type InsightStatusMetric,
} from "@/hooks/use-insight-status";
import { useTranslations } from "@/lib/i18n/context";
import { InsightStatusCard } from "@/components/insights/insight-status-card";

interface SlugInsightStatusCardProps {
  /** The bespoke metric slug the `/api/insights/<slug>-status` route keys on. */
  slug: InsightStatusMetric;
  /** The leading glyph (Scale, Smile, Pill, …). */
  icon: ReactNode;
}

/**
 * Shared mount for the bespoke per-metric assessment card.
 *
 * The five bespoke slug pages (`weight`, `bmi`, `pulse`, `blood-pressure`,
 * `mood`) each hand-wired the same eight-prop `<InsightStatusCard>` block off
 * `useInsightStatus(slug)`, with only the icon differing. This seam owns the
 * hook + the `status?.x ?? default` prop-defaulting so the title and every
 * field name live in one place — the sibling of `<MetricStatusCard>`, which
 * does the same for the generic `useInsightMetricStatus(metric)` route. Each
 * bespoke page drops ~9 lines and can no longer drift on a field name.
 */
export function SlugInsightStatusCard({
  slug,
  icon,
}: SlugInsightStatusCardProps) {
  const { t } = useTranslations();
  const { data: status, isLoading } = useInsightStatus(slug);

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
