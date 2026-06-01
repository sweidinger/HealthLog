"use client";

import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { MoodHeatmap } from "@/components/charts/mood-heatmap";
import {
  MoodDistributionChart,
  type MoodDistributionRow,
} from "./mood-distribution-chart";
import {
  MoodWeekdayChart,
  type MoodWeekdayRow,
} from "./mood-weekday-chart";
import {
  MoodTagBreakdown,
  type MoodTagRow,
} from "./mood-tag-breakdown";
import {
  MoodCorrelationCards,
  type MoodMetricCorrelationData,
} from "./mood-correlation-cards";

/**
 * v1.8.5 — additional Mood Insights sections.
 *
 * Reads the pre-computed aggregate bundle from `/api/mood/insights`
 * (cheap cached server read, no LLM) and paints the heatmap,
 * distribution, weekday pattern, tag breakdown, and mood × metric
 * correlation cards. Renders nothing while loading / on error / on an
 * empty data set so the page degrades gracefully to the line chart.
 */

interface MoodInsightsResponse {
  summary: {
    totalEntries: number;
  };
  heatmap: {
    windowDays: number;
    cells: Array<{ date: string; score: number; samples: number }>;
  };
  distribution: MoodDistributionRow[];
  weekday: MoodWeekdayRow[];
  tags: MoodTagRow[];
  correlations: {
    sleep: MoodMetricCorrelationData;
    steps: MoodMetricCorrelationData;
    pulse: MoodMetricCorrelationData;
  };
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function MoodInsightsSections() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.moodInsights(),
    queryFn: async () => {
      const res = await fetch("/api/mood/insights");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as MoodInsightsResponse;
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  if (isLoading) {
    return <Skeleton className="h-48 w-full rounded-lg" />;
  }

  if (!data || data.summary.totalEntries === 0) {
    return null;
  }

  const heatmapCells = Object.fromEntries(
    data.heatmap.cells.map((cell) => [cell.date, cell]),
  );

  const hasTags = data.tags.length > 0;

  return (
    <div className="space-y-4">
      <SectionCard title={t("insights.mood.heatmapTitle")}>
        <MoodHeatmap
          cells={heatmapCells}
          days={data.heatmap.windowDays}
          stretch
        />
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={t("insights.mood.distributionTitle")}>
          <MoodDistributionChart distribution={data.distribution} />
        </SectionCard>
        <SectionCard title={t("insights.mood.weekdayTitle")}>
          <MoodWeekdayChart weekday={data.weekday} />
        </SectionCard>
      </div>

      {hasTags && (
        <SectionCard title={t("insights.mood.tagsTitle")}>
          <MoodTagBreakdown tags={data.tags} />
        </SectionCard>
      )}

      <div className="space-y-2">
        <h3 className="text-base font-semibold">
          {t("insights.mood.correlationsTitle")}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t("insights.mood.correlationsDescription")}
        </p>
        <MoodCorrelationCards
          sleep={data.correlations.sleep}
          steps={data.correlations.steps}
          pulse={data.correlations.pulse}
        />
      </div>
    </div>
  );
}
