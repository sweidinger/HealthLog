"use client";

import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { MoodHeatmap } from "@/components/charts/mood-heatmap";
// v1.12.1 — the three Recharts mini-charts on this below-fold cluster are
// deferred via `next/dynamic`. The mood hero line chart above them is
// already dynamic on the page, so static-importing these pulled Recharts
// into the initial chunk for no first-paint benefit. Each loader paints a
// skeleton sized to the chart's own band so the deferred chunk arrives
// without a layout shift (charts stay Recharts, visually identical). Types
// stay value-free imports so they don't drag the chunk back in.
import type { MoodDistributionRow } from "./mood-distribution-chart";
import type { MoodWeekdayRow } from "./mood-weekday-chart";
import type { MoodTimeOfDayPattern } from "./mood-time-of-day-chart";
const MoodDistributionChart = dynamic(
  () =>
    import("./mood-distribution-chart").then((mod) => ({
      default: mod.MoodDistributionChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="aspect-[3/2] min-h-[180px] w-full rounded-md" />
    ),
  },
);
const MoodWeekdayChart = dynamic(
  () =>
    import("./mood-weekday-chart").then((mod) => ({
      default: mod.MoodWeekdayChart,
    })),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="aspect-[3/2] min-h-[160px] w-full rounded-md" />
    ),
  },
);
const MoodTimeOfDayChart = dynamic(
  () =>
    import("./mood-time-of-day-chart").then((mod) => ({
      default: mod.MoodTimeOfDayChart,
    })),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[220px] w-full rounded-md" />,
  },
);
import {
  MoodTagBreakdown,
  type MoodTagRow,
} from "./mood-tag-breakdown";
import {
  MoodCorrelationCards,
  type MoodMetricCorrelationData,
} from "./mood-correlation-cards";
import {
  MoodStructuredTagBreakdown,
  type MoodStructuredTagRow,
} from "./mood-structured-tag-breakdown";
import {
  MoodNarrativeFeed,
  type MoodNarrativeItem,
} from "./mood-narrative-feed";
import { MoodInTargetTile } from "./mood-in-target-tile";
import {
  MoodStabilityTile,
  type MoodStabilityData,
} from "./mood-stability-tile";
import {
  MoodTagInfluence,
  type MoodTagInfluenceRow,
} from "./mood-tag-influence";
import {
  MoodBetterDays,
  type MoodBetterDayFactor,
} from "./mood-better-days";
import {
  MoodTagMetricCrosstab,
  type MoodTagMetricCrosstabRow,
} from "./mood-tag-metric-crosstab";
import { MoodDiscoveredRelations } from "./mood-discovered-relations";

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
    inTargetPct: number | null;
  };
  heatmap: {
    windowDays: number;
    cells: Array<{ date: string; score: number; samples: number }>;
  };
  distribution: MoodDistributionRow[];
  weekday: MoodWeekdayRow[];
  timeOfDay: MoodTimeOfDayPattern;
  stability: MoodStabilityData | null;
  tags: MoodTagRow[];
  structuredTags: MoodStructuredTagRow[];
  // Optional only to tolerate a stale pre-v1.11.5 cached payload during a
  // rollout; the live endpoint always populates both.
  tagInfluence?: {
    flat: MoodTagInfluenceRow[];
    structured: MoodTagInfluenceRow[];
  };
  betterDays?: MoodBetterDayFactor[];
  // Optional only to tolerate a stale pre-v1.12.0 cached payload during a
  // rollout; the live endpoint always populates it.
  tagMetricCrosstab?: MoodTagMetricCrosstabRow[];
  narratives: MoodNarrativeItem[];
  correlations: {
    sleep: MoodMetricCorrelationData;
    steps: MoodMetricCorrelationData;
    pulse: MoodMetricCorrelationData;
    weight: MoodMetricCorrelationData;
    bloodPressureSystolic: MoodMetricCorrelationData;
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
  const hasStructuredTags = data.structuredTags.length > 0;

  // The in-target tile is the canonical surface for the in-target share.
  // When it renders (inTargetPct present) drop the same-number `in-target`
  // takeaway from the feed so the percentage appears exactly once on the
  // page. The narrative still rides the API/LLM payload unchanged.
  const inTargetShown = data.summary.inTargetPct != null;
  const narratives = inTargetShown
    ? data.narratives.filter((item) => item.kind !== "in-target")
    : data.narratives;

  const hasStabilityTile = data.stability != null;
  const hasInTargetTile = data.summary.inTargetPct != null;

  // F1 — fold the structured + flat influence axes into one list ranked by
  // absolute delta, so the strongest "this tag moves my mood" rows lead
  // regardless of which axis they came from. Defensive against a stale
  // server-cache payload minted before the v1.11.5 shape landed (the
  // aggregate is cached up to 60 s; a rollout can serve one old read).
  const influenceRows = [
    ...(data.tagInfluence?.structured ?? []),
    ...(data.tagInfluence?.flat ?? []),
  ].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const hasInfluence = influenceRows.length > 0;
  const betterDays = data.betterDays ?? [];
  const hasBetterDays = betterDays.length > 0;
  const crosstabRows = data.tagMetricCrosstab ?? [];
  const hasCrosstab = crosstabRows.length > 0;

  return (
    <div className="space-y-4">
      {(hasInTargetTile || hasStabilityTile) && (
        // Two-up only when BOTH tiles render; a lone tile spans full width so
        // it never leaves a half-width orphan with dead space beside it.
        <div
          className={cn(
            "grid gap-4",
            hasInTargetTile && hasStabilityTile && "sm:grid-cols-2",
          )}
        >
          {hasInTargetTile && (
            <MoodInTargetTile pct={data.summary.inTargetPct} />
          )}
          {hasStabilityTile && (
            <MoodStabilityTile stability={data.stability} />
          )}
        </div>
      )}

      <MoodNarrativeFeed items={narratives} />

      {hasBetterDays && (
        <SectionCard title={t("insights.mood.betterDays.title")}>
          <MoodBetterDays factors={betterDays} />
        </SectionCard>
      )}

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

      {data.timeOfDay.reliable && (
        <SectionCard title={t("insights.mood.timeOfDay.title")}>
          <MoodTimeOfDayChart pattern={data.timeOfDay} />
        </SectionCard>
      )}

      {hasStructuredTags && (
        <SectionCard title={t("insights.mood.structuredTagsTitle")}>
          <MoodStructuredTagBreakdown tags={data.structuredTags} />
        </SectionCard>
      )}

      {hasTags && (
        <SectionCard title={t("insights.mood.tagsTitle")}>
          <MoodTagBreakdown tags={data.tags} />
        </SectionCard>
      )}

      {hasInfluence && (
        <SectionCard title={t("insights.mood.influence.title")}>
          <MoodTagInfluence rows={influenceRows} />
        </SectionCard>
      )}

      {hasCrosstab && (
        <SectionCard title={t("insights.mood.crosstab.title")}>
          <MoodTagMetricCrosstab rows={crosstabRows} />
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
          weight={data.correlations.weight}
          bloodPressureSystolic={data.correlations.bloodPressureSystolic}
        />
      </div>

      {/* F3 — the FDR-controlled discovered mood relations. Self-fetches the
          correlation-discovery surface and renders nothing when the operator
          disabled it, while loading, or when no mood pair cleared the bar. */}
      <MoodDiscoveredRelations />
    </div>
  );
}
