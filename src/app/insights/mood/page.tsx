"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Smile } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { useInsightsLayoutPrefs } from "@/hooks/use-insights-layout-prefs";
import { Button } from "@/components/ui/button";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { MoodInsightsSections } from "@/components/insights/mood/mood-insights-sections";
import { SlugInsightStatusCard } from "@/components/insights/slug-insight-status-card";
import { SubPageShell } from "@/components/insights/sub-page-shell";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.4.25 W4 — `/insights/mood`.
 *
 * Routed Mood sub-page. Unlike the mother page (which hid the mood
 * section entirely when no mood data existed), a dedicated sub-page
 * cannot just blank itself — we'd land on an empty white page. Instead,
 * the sub-page surfaces a clear empty-state CTA into `/mood` so the
 * user can log their first entry, matching the Apple Health "No data"
 * convention (research §1.1).
 */
const MoodChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

interface ComprehensiveMoodData {
  moodSummary: { count: number } | null;
}

export default function InsightsStimmungPage() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  const { compareBaseline } = useInsightsLayoutPrefs(isAuthenticated);

  // Reuse the mother-page comprehensive query — TanStack Query
  // dedups so this is a free cache read for the common case.
  const { data: comprehensive } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      return apiGet<ComprehensiveMoodData>("/api/insights/comprehensive");
    },
    enabled: isAuthenticated,
  });

  const moodCount = comprehensive?.moodSummary?.count ?? 0;

  // v1.4.27 F17 — Mood is event-driven so the gate reads
  // `hasMood = moodCount > 0`. CTA targets `/mood` (the dedicated
  // mood-logging surface) — short-circuits the user to the quickest
  // path to log their first entry.
  //
  // v1.4.28 R3d (BK-F-M1) — empty-state render delegates to the shared
  // `<MetricEmptyState>` primitive. The mood data path stays on
  // `/api/insights/comprehensive` because the `moodSummary.count`
  // signal is event-driven, not sensor-aggregated.
  if (isAuthenticated && comprehensive && moodCount === 0) {
    return (
      <SubPageShell
        title={t("insights.moodSectionTitle")}
        description={t("insights.subPage.stimmungDescription")}
        explainerMetric="mood"
      >
        <MetricEmptyState
          icon={<Smile className="size-6" />}
          title={t("insights.emptyState.mood.title")}
          description={t("insights.emptyState.mood.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/mood">{t("insights.emptyState.mood.cta")}</Link>
            </Button>
          }
          coachPrefill="I haven't logged any mood entries yet — why does mood tracking matter, and how should I start?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.moodSectionTitle")}
      description={t("insights.subPage.stimmungDescription")}
      explainerMetric="mood"
      coachLaunch
    >
      {/* v1.12.7 — operator spine: heading + summary (the shell above), then
          the Stimmungskalender, then the line chart, then the Ziel card, then
          the better-days Einschätzung, then the classification + breakdowns.
          The heatmap and the assessment are lifted out of `MoodInsightsSections`
          into their own regions so they land in this exact order; all three
          regions share one `moodInsights` query (TanStack dedups the fetch). */}
      <MoodInsightsSections region="heatmap" />

      {/* No `<MetricRangeControls>` here: mood is event-driven, not a
          MeasurementType series, so the period-over-period range read
          (`/api/analytics/range`, keyed on a MeasurementType enum) has
          nothing to aggregate. */}
      <MoodChart chartKey="mood" compareBaseline={compareBaseline} />

      <MetricTargetSummary slug="mood" />

      {/* The better-days Einschätzung sits directly under the Ziel card,
          ahead of the classification tiles and breakdowns. */}
      <MoodInsightsSections region="assessment" />

      <MoodInsightsSections region="rest" />

      {/* v1.12.2 — the assessment is the LAST block on every bespoke
          metric-detail page, matching the canonical spine the generic
          scaffold (weight / bmi / pulse / blood-pressure) renders. The
          reader sees the trend and the breakdown sections first, then the
          narration of them at the foot. */}
      <SlugInsightStatusCard slug="mood" icon={<Smile className="h-5 w-5" />} />
    </SubPageShell>
  );
}
