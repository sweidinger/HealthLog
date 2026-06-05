"use client";

import Link from "next/link";
import { Moon } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useInsightsAnalytics } from "@/hooks/use-insights-analytics";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { MeasurementDiversityNudge } from "@/components/insights/measurement-diversity-nudge";
import { MetricStatusCard } from "@/components/insights/metric-status-card";
import { MetricEmptyState } from "@/components/insights/metric-empty-state";
import { MetricTargetSummary } from "@/components/insights/metric-target-summary";
import { SleepOverview } from "@/components/insights/sleep-overview";
import { SubPageShell } from "@/components/insights/sub-page-shell";

/**
 * v1.4.25 W4c — `/insights/sleep`.
 *
 * The Sleep sub-page surfaces the per-stage breakdown + duration trend
 * the v1.4.23 schema gained but never rendered. All charts live inside
 * `<SleepOverview>` so the page-level scaffold stays trivial; data
 * fetches and empty-state handling are encapsulated in the component.
 *
 * v1.4.27 F17 — when `summaries.SLEEP_DURATION.count === 0` (no
 * Apple-Health / Withings sleep rows yet), the page short-circuits
 * to an empty-state CTA pointing at `/settings/data-sources` so the
 * user can connect a sleep source.
 *
 * v1.4.28 R3d (BK-F-H1 + BK-F-M1) — analytics fetch + empty-state
 * render consume the shared hook + primitive.
 */
export default function InsightsSchlafPage() {
  const { t } = useTranslations();
  const { user } = useAuth();

  const { isEmpty } = useInsightsAnalytics("SLEEP_DURATION");

  if (isEmpty) {
    return (
      <SubPageShell
        title={t("insights.sleep.title")}
        description={t("insights.sleep.description")}
        explainerMetric="sleep"
      >
        <MetricEmptyState
          icon={<Moon className="size-6" />}
          title={t("insights.emptyState.sleep.title")}
          description={t("insights.emptyState.sleep.description")}
          cta={
            <Button size="sm" asChild>
              <Link href="/settings/data-sources">
                {t("insights.emptyState.sleep.cta")}
              </Link>
            </Button>
          }
          coachPrefill="I don't have any sleep data yet — why does sleep tracking matter, and what should I know before I connect a source?"
        />
      </SubPageShell>
    );
  }

  return (
    <SubPageShell
      title={t("insights.sleep.title")}
      description={t("insights.sleep.description")}
      explainerMetric="sleep"
      coachLaunch
      diversityNudge={
        <MeasurementDiversityNudge
          measurementType="SLEEP_DURATION"
          metricLabel={t("insights.sleep.title")}
          timeZone={user?.timezone ?? undefined}
        />
      }
      showAllValuesType="SLEEP_DURATION"
      /* No `statStrip`: `<SleepOverview>` already leads with the average
         nightly total + per-stage breakdown, so a duration-in-minutes
         min / max / median / mean strip would duplicate it and read in an
         awkward unit. */
    >
      <SleepOverview />

      <MetricTargetSummary slug="sleep" />

      {/*
        v1.8.7.1 — the per-section sleep assessment lands via the generic
        metric-status route (`?metric=SLEEP_DURATION`), closing the slot
        the v1.4.28 deferral left open. The shared `<MetricStatusCard>`
        owns the hook + card; only the icon differs from the HealthKit
        scaffold (Moon vs Sparkles). The card mounts only on this
        data-bearing branch, so a source-less account never fetches.
      */}
      <MetricStatusCard
        metric="SLEEP_DURATION"
        icon={<Moon className="h-5 w-5" />}
        enabled={!isEmpty}
      />
    </SubPageShell>
  );
}
