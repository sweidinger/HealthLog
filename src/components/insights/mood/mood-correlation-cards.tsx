"use client";

import dynamic from "next/dynamic";
import { Activity } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations } from "@/lib/i18n/context";
import type { CorrelationResult } from "@/lib/analytics/correlations";

/**
 * v1.8.5 — mood × metric correlation cards (Apple "Life Factors" parity).
 *
 * Reuses the shared `<ScatterCorrelationChart>` (same wrapper the
 * mother-page correlation cards ride) for each mood × (sleep / steps /
 * pulse) pair. The Pearson math comes pre-computed from
 * `/api/mood/insights` (single source of truth with the LLM snapshot).
 * Below-threshold pairs render an EmptyState rather than a misleading
 * near-zero scatter.
 */

const ScatterCorrelationChart = dynamic(
  () =>
    import("@/components/charts/scatter-correlation-chart").then((mod) => ({
      default: mod.ScatterCorrelationChart,
    })),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted/40 aspect-square min-h-[180px] w-full animate-pulse rounded-md motion-reduce:animate-none sm:aspect-[3/2] sm:h-auto" />
    ),
  },
);

export interface MoodCorrelationPoint {
  x: number;
  y: number;
  [key: string]: number;
}

export interface MoodMetricCorrelationData {
  result: CorrelationResult | null;
  points: MoodCorrelationPoint[];
  n: number;
}

type MetricKind = "sleep" | "steps" | "pulse";

const TITLE_KEY: Record<MetricKind, string> = {
  sleep: "insights.mood.correlation.sleepTitle",
  steps: "insights.mood.correlation.stepsTitle",
  pulse: "insights.mood.correlation.pulseTitle",
};

const Y_LABEL_KEY: Record<MetricKind, string> = {
  sleep: "insights.mood.correlation.sleepAxis",
  steps: "insights.mood.correlation.stepsAxis",
  pulse: "insights.mood.correlation.pulseAxis",
};

const FILL_BY_KIND: Record<MetricKind, string> = {
  sleep: "var(--dracula-purple)",
  steps: "var(--dracula-cyan)",
  pulse: "var(--dracula-pink)",
};

const STRENGTH_KEY: Record<CorrelationResult["strength"], string> = {
  stark: "insights.mood.correlation.strengthStrong",
  moderat: "insights.mood.correlation.strengthModerate",
  schwach: "insights.mood.correlation.strengthWeak",
  keine: "insights.mood.correlation.strengthNone",
};

function MoodCorrelationCard({
  kind,
  data,
}: {
  kind: MetricKind;
  data: MoodMetricCorrelationData;
}) {
  const { t } = useTranslations();
  const hasResult = data.result != null && data.n >= 5;

  return (
    <Card data-slot="mood-correlation-card" data-kind={kind}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold">
            {t(TITLE_KEY[kind])}
          </CardTitle>
          {hasResult && data.result && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {t(STRENGTH_KEY[data.result.strength])}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasResult && data.result ? (
          <>
            <ScatterCorrelationChart
              data={data.points}
              fill={FILL_BY_KIND[kind]}
              xAxis={{
                dataKey: "x",
                name: t("insights.moodSectionTitle"),
                domain: [1, 5],
                ticks: [1, 2, 3, 4, 5],
              }}
              yAxis={{ dataKey: "y", name: t(Y_LABEL_KEY[kind]) }}
              height={180}
            />
            <p className="text-muted-foreground text-[11px]">
              {t("insights.mood.correlation.source", {
                n: data.n,
                r: data.result.r.toFixed(2),
              })}
            </p>
          </>
        ) : (
          <EmptyState
            variant="plain"
            size="compact"
            icon={<Activity className="size-5" />}
            title={t("insights.mood.correlation.emptyTitle")}
            description={t("insights.mood.correlation.emptyDescription")}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function MoodCorrelationCards({
  sleep,
  steps,
  pulse,
}: {
  sleep: MoodMetricCorrelationData;
  steps: MoodMetricCorrelationData;
  pulse: MoodMetricCorrelationData;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <MoodCorrelationCard kind="sleep" data={sleep} />
      <MoodCorrelationCard kind="steps" data={steps} />
      <MoodCorrelationCard kind="pulse" data={pulse} />
    </div>
  );
}
