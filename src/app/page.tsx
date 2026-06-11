"use client";

import React, { Suspense, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  Activity,
  Droplet,
  Footprints,
  Gauge,
  Heart,
  Moon,
  Percent,
  Plus,
  Smile,
  Target,
  TrendingUp,
} from "lucide-react";
import { convertGlucose, resolveGlucoseUnit } from "@/lib/glucose";
import { cn } from "@/lib/utils";
import {
  resolveDashboardLayout,
  DASHBOARD_WIDGET_IDS,
  type DashboardLayout,
} from "@/lib/dashboard-layout";
import type { DashboardAnalyticsData as AnalyticsData } from "@/types/analytics";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamic } from "@/components/charts/health-chart-dynamic";
import {
  DashboardChartCell,
  useDashboardChartReveal,
} from "@/components/dashboard/chart-reveal";
import { DashboardHeader } from "@/components/dashboard/dashboard-header";
import {
  QuickEntrySheets,
  type QuickEntryDialog,
} from "@/components/dashboard/quick-entry-sheets";
import {
  getHourForTimeZone,
  getRangeColorClass,
  getRangeHint,
  toHoursSummary,
} from "@/components/dashboard/range-display";
import { TrendCard } from "@/components/charts/trend-card";
import { TrendCardSkeleton } from "@/components/charts/trend-card-skeleton";
import { TrendHint } from "@/components/charts/trend-hint";
import { summaryToTrend7Delta } from "@/lib/analytics/trend-delta";
import { GettingStartedChecklist } from "@/components/onboarding/getting-started-checklist";
import { TourLauncher } from "@/components/onboarding/tour-launcher";
import { RecentAchievementsCard } from "@/components/gamification/recent-achievements-card";
import { RecentWorkoutsTile } from "@/components/dashboard/recent-workouts-tile";

// v1.4.40 W-RSC — module-scope so the option object is stable across
// renders (audit-M2). Pre-fix the same literal was declared inside the
// component body, so every render created a fresh `{}` reference;
// TanStack does a shallow compare and shrugs at the equivalent values,
// but the slot is one future-callback-field away from cache poisoning.
const DASHBOARD_QUERY_OPTS = {
  staleTime: 60_000,
  refetchOnWindowFocus: false,
} as const;

const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
const MedicationComplianceChart = dynamic(
  () =>
    import("@/components/charts/medication-compliance-chart").then((mod) => ({
      default: mod.MedicationComplianceChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useDashboardSnapshot } from "@/lib/queries/use-dashboard-snapshot";
import { isDashboardSnapshotEnabled } from "@/lib/dashboard/snapshot-flag";
import type { DataSummary } from "@/lib/analytics/trends";
import { mergeSlimAndThickAnalytics } from "@/lib/analytics/merge-slim-thick";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightBandsFromHeight,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.7.0 — first-paint gate for the dashboard tile strip.
 *
 * `primaryLoading` must come from whichever query actually drives the
 * tiles: the snapshot cell by default, the slim analytics cell when
 * `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false`. A disabled TanStack query reports
 * `isLoading: false` (idle fetch status), so keying off the wrong
 * source flashes the empty state for the whole fetch. Pure + exported
 * so the gate has direct unit coverage without mounting the page.
 */
export function resolveDashboardFirstPaintGate(input: {
  trendCardCount: number;
  chartCount: number;
  configuredTileCount: number;
  primaryLoading: boolean;
}): { showTileStripSkeleton: boolean; showEmptyState: boolean } {
  const showTileStripSkeleton =
    input.trendCardCount === 0 &&
    input.primaryLoading &&
    input.configuredTileCount > 0;
  const showEmptyState =
    input.trendCardCount === 0 &&
    input.chartCount === 0 &&
    !showTileStripSkeleton &&
    !input.primaryLoading;
  return { showTileStripSkeleton, showEmptyState };
}

export default function DashboardPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [quickEntryDialog, setQuickEntryDialog] =
    useState<QuickEntryDialog>(null);
  // v1.4.29 M5 — the three inline dashboard queries default to a
  // 0-ms `staleTime`, so a tab-focus-and-return triggered a refetch
  // storm. None of these are real-time data; minute-scale staleness
  // is fine and the dashboard's chart queries already match this
  // cadence.
  //
  // v1.4.40 W-RSC — `DASHBOARD_QUERY_OPTS` hoisted to module scope
  // (audit-M2 — stable reference across renders).

  // v1.4.39.2 — split the dashboard's analytics consumption so the
  // tile-strip paints from the slim slice and the BD-Zielbereich +
  // glucose tiles stream in from the thick slice afterwards.
  //
  // Pre-fix: a single `useAnalyticsQuery()` against `/api/analytics`
  // (thick slice) blocked every per-type tile until the heavy fan-out
  // resolved. Mood and medication tiles paint from their own dedicated
  // endpoints and arrived first; the per-type measurement tiles then
  // arrived as one burst once the full slice landed — the maintainer reported
  // this "blocked-then-burst" pattern as "etwas nervig".
  //
  // Post-fix: two parallel queries. The slim slice (`?slice=summaries`)
  // resolves the per-type DataSummary headlines + `lastSeenByType` and
  // typically returns in well under a second once the rollup tier is
  // warm; that paints every per-type tile in the strip. The thick
  // slice resolves `bpInTargetPct*` + `glucoseByContext` for the
  // BD-Zielbereich and glucose tiles, which stream in independently.
  // Both queries share `caches.analytics` server-side so warm hits
  // stay free, and TanStack's parallel-mounting keeps the network fan-
  // out flat.
  // Unified first-paint snapshot (reversible rollout flag, default ON).
  // Every tile hydrates from ONE un-gated `/api/dashboard/snapshot` cell
  // so the whole strip shares one completion moment and the
  // `/api/auth/me` round-trip leaves the cold critical path. Set
  // `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=false` to fall back to the legacy
  // four independent cells.
  const snapshotEnabled = isDashboardSnapshotEnabled();
  const snapshotQuery = useDashboardSnapshot(snapshotEnabled);

  const analyticsSlimQuery = useAnalyticsQuery({
    slice: "summaries",
    enabled: !snapshotEnabled && isAuthenticated,
  });
  const analyticsThickQuery = useAnalyticsQuery({
    enabled: !snapshotEnabled && isAuthenticated,
  });
  const data = useMemo<AnalyticsData | undefined>(() => {
    // v1.7.0 W6 — snapshot path: assemble the same `AnalyticsData`
    // shape from the single snapshot cell so every downstream tile
    // reads unchanged. `extras` is null on a rollup-coverage miss
    // (two-phase contract) → the BD-Zielbereich + glucose fields stay
    // undefined and those tiles render their per-tile shimmer while the
    // rest of the strip paints.
    if (snapshotEnabled) {
      const snap = snapshotQuery.data;
      if (!snap) return undefined;
      return {
        summaries: snap.tiles.summaries,
        lastSeenByType: snap.tiles.lastSeenByType,
        bpInTargetPct: snap.extras?.bpInTargetPct ?? null,
        bpInTargetPct7d: snap.extras?.bpInTargetPct7d ?? null,
        bpInTargetPct30d: snap.extras?.bpInTargetPct30d ?? null,
        bpInTargetPctAllTime: snap.extras?.bpInTargetPctAllTime ?? null,
        bpInTargetPctPriorMonth: snap.extras?.bpInTargetPctPriorMonth ?? null,
        bpInTargetPctPriorYear: snap.extras?.bpInTargetPctPriorYear ?? null,
        glucoseByContext: snap.extras?.glucoseByContext as
          | Record<string, DataSummary>
          | undefined,
      };
    }
    // v1.4.39.3 — the merge moved to `mergeSlimAndThickAnalytics` so
    // the empty-slim-vs-populated-thick edge has direct unit
    // coverage. Pre-fix the inline `slim?.summaries ?? thick?.summaries`
    // short-circuited on a truthy-but-empty `{}` from the slim slice
    // and blanked the tile strip even when thick carried the full
    // payload — the regression the maintainer's v1.4.39.3 e2e CI flagged across
    // eight dashboard / chart specs. The helper falls back to thick
    // when slim resolves with no content and otherwise keeps the
    // v1.4.39.2 slim-wins-first progressive-paint contract.
    const merged = mergeSlimAndThickAnalytics(
      analyticsSlimQuery.data,
      analyticsThickQuery.data,
    );
    if (!merged) return undefined;
    return {
      summaries: merged.summaries,
      lastSeenByType: merged.lastSeenByType,
      bpInTargetPct: merged.bpInTargetPct,
      bpInTargetPct7d: merged.bpInTargetPct7d,
      bpInTargetPct30d: merged.bpInTargetPct30d,
      bpInTargetPctAllTime: merged.bpInTargetPctAllTime,
      bpInTargetPctPriorMonth: merged.bpInTargetPctPriorMonth,
      bpInTargetPctPriorYear: merged.bpInTargetPctPriorYear,
      glucoseByContext: merged.glucoseByContext as
        | Record<string, DataSummary>
        | undefined,
    };
  }, [
    snapshotEnabled,
    snapshotQuery.data,
    analyticsSlimQuery.data,
    analyticsThickQuery.data,
  ]);

  const { data: layoutDataLegacy } = useQuery({
    queryKey: queryKeys.dashboardWidgets(),
    queryFn: async () => {
      return apiGet<DashboardLayout>("/api/dashboard/widgets");
    },
    enabled: !snapshotEnabled && isAuthenticated,
    ...DASHBOARD_QUERY_OPTS,
  });
  const layoutData = snapshotEnabled
    ? snapshotQuery.data?.layout
    : layoutDataLegacy;

  const { data: moodDataLegacy } = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async () => {
      return apiGet<{
        entries: Array<{ date: string; score: number; samples: number }>;
        summary: DataSummary;
      }>("/api/mood/analytics");
    },
    enabled: !snapshotEnabled && isAuthenticated,
    ...DASHBOARD_QUERY_OPTS,
  });
  const moodData = snapshotEnabled
    ? snapshotQuery.data
      ? {
          entries: snapshotQuery.data.tiles.mood.entries,
          summary: (snapshotQuery.data.tiles.mood.summary ??
            undefined) as DataSummary,
        }
      : undefined
    : moodDataLegacy;

  // v1.4.27 B1 — the dashboard's `<InsightsCardPreview>` retired (it
  // duplicated the much-richer `/insights` advisor surface). The advisor
  // query lives on `/insights` directly; the dashboard no longer needs
  // its own hook subscription, so the local `useInsightsAdvisorQuery`
  // call dropped with the preview.

  // v1.4.27 — per-tile availability gates live a few lines below as the
  // existing `hasWeight` / `hasBp` / `hasPulse` / `hasBodyFat` / `hasMood` /
  // `hasSleep` / `hasSteps` flags. They mirror `hasMetricData` from
  // `src/lib/insights/metric-availability.ts` for the routed Insights
  // surfaces — both branches read `summaries[METRIC].count > 0`.

  const w = data?.summaries?.WEIGHT;
  const sys = data?.summaries?.BLOOD_PRESSURE_SYS;
  const dia = data?.summaries?.BLOOD_PRESSURE_DIA;
  const p = data?.summaries?.PULSE;
  // v1.15.12 A2 — the resting-pulse target band is judged against the
  // RESTING_HEART_RATE series (Apple's clean daily resting figure), not
  // raw PULSE which mixes in workout HR. When the user has resting rows,
  // the pulse tile shows the resting figure + the resting-band colour;
  // when only raw PULSE exists, the tile shows heart rate WITHOUT the
  // resting-band colour overlay (no "outside target" over workout HR).
  const rhr = data?.summaries?.RESTING_HEART_RATE;
  const hasRestingHr = (rhr?.count ?? 0) > 0;
  const pulseTileSummary = hasRestingHr ? rhr : p;
  const bf = data?.summaries?.BODY_FAT;
  const sleepSummary = data?.summaries?.SLEEP_DURATION;
  // v1.11.4 — `summaries.SLEEP_DURATION` now carries per-NIGHT time-asleep
  // totals in MINUTES (the server collapses the per-stage rows into one
  // night value; see `summaries-slice.ts`). The sleep tile renders hours,
  // so convert every value field minutes→hours here while keeping the
  // staleness / count metadata untouched. This is the web-parity twin of
  // the iOS dashboard-summary route which already emits `unit:"h"`.
  const sleepSummaryHours = sleepSummary
    ? toHoursSummary(sleepSummary)
    : undefined;
  const stepsSummary = data?.summaries?.ACTIVITY_STEPS;
  // v1.4.25 W8d — VO2 max secondary-metric tile. /api/analytics
  // auto-populates this summary because the route iterates over the
  // full measurementTypeEnum.options list; no backend change needed.
  const vo2Summary = data?.summaries?.VO2_MAX;
  const moodSummary = moodData?.summary;

  // Resolve full dashboard layout — controls visibility + order of every widget
  const layout = resolveDashboardLayout(layoutData);
  /**
   * v1.4.16 phase B8 — comparison baseline (Vormonat / Vorjahr) read
   * from the resolved layout so every chart + tile on the dashboard
   * receives the same value. "none" = comparison off (pre-B8 default).
   */
  const compareBaseline = layout.comparisonBaseline ?? "none";

  /**
   * v1.4.16 phase B8 — derive the tile-delta value (current 30d avg
   * minus prior-period 30d avg) for any DataSummary. Returns null
   * when comparison is off OR either side is missing data so the
   * tile can suppress the callout cleanly.
   */
  const tileCompareDelta = (
    summary: DataSummary | null | undefined,
  ): number | null => {
    if (!summary || compareBaseline === "none") return null;
    const current = summary.avg30 ?? null;
    const prior =
      compareBaseline === "lastMonth"
        ? (summary.avg30LastMonth ?? null)
        : (summary.avg30LastYear ?? null);
    if (current === null || prior === null) return null;
    return Math.round((current - prior) * 100) / 100;
  };

  /**
   * v1.4.34 IW-B — read the per-type freshness map and surface the
   * `daysAgo` value when the metric is older than a week. The
   * tile-strip below forwards the result to `<TrendCard staleDays>`
   * which picks the bucket-aware copy (Xd / X weeks / X months) and
   * paints the caption on the tile. Returns `null` for metrics with no
   * reading yet OR within the fresh window so call sites stay
   * undefined-safe and tiles with recent data paint byte-identical
   * with the pre-v1.4.34 contract.
   */
  const tileStaleDays = (type: string | null | undefined): number | null => {
    if (!type) return null;
    const entry = data?.lastSeenByType?.[type];
    if (!entry) return null;
    return entry.daysAgo > 7 ? entry.daysAgo : null;
  };
  /** Whether the widget's *chart* (lower row) shows. */
  const isChartVisible = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.visible ?? false;
  /**
   * v1.4.15 Fix 5 — whether the widget's *tile* in the strip shows.
   * Independent of the chart visibility so the user can hide chart but
   * keep the tile (or vice versa) from Settings → Dashboard. Falls back
   * to chart visibility for layouts saved before v1.4.15.
   */
  const isTileVisible = (id: string) => {
    const widget = layout.widgets.find((w) => w.id === id);
    if (!widget) return false;
    return typeof widget.tileVisible === "boolean"
      ? widget.tileVisible
      : widget.visible;
  };
  const widgetOrder = (id: string) =>
    layout.widgets.find((widget) => widget.id === id)?.order ?? 999;

  // Data-floor gates (widget shows iff visible AND has data)
  const hasWeight = (w?.count ?? 0) > 0;
  const hasBp = (sys?.count ?? 0) > 0 || (dia?.count ?? 0) > 0;
  // v1.15.12 A2 — the pulse tile shows resting HR when available, else
  // raw PULSE; either signal having data shows the tile.
  const hasPulse = (p?.count ?? 0) > 0 || (rhr?.count ?? 0) > 0;
  const hasBodyFat = (bf?.count ?? 0) > 0;
  const hasMood = (moodSummary?.count ?? 0) > 0;
  const hasSleep = (sleepSummary?.count ?? 0) > 0;
  const hasSteps = (stepsSummary?.count ?? 0) > 0;
  const hasVo2 = (vo2Summary?.count ?? 0) > 0;
  /**
   * v1.4.33 F4 — gate the BD-Zielbereich tile so a literal "0,0 %"
   * placeholder doesn't ride on the dashboard when none of the user's
   * paired readings sit inside the target band. The historical
   * behaviour (`!= null`) painted the tile whenever the analytics
   * route emitted a numeric percentage, including the legitimate-but-
   * misleading zero. The corrected gate requires at least one window
   * (7d, 30d, all-time) to report a non-zero share. When every
   * window is zero, the tile is hidden — the user sees the BP charts
   * + the Insights blood-pressure target panel for the deeper analysis
   * instead.
   * The audit's F4 reproduction sat on 540 BP samples with all sub-
   * windows reading 0 % because the seed data straddled the target
   * ceiling; the tile keeps its place once even one sub-window
   * crosses zero.
   */
  const hasBpInTarget =
    data?.bpInTargetPct != null &&
    [
      data?.bpInTargetPct,
      data?.bpInTargetPct7d,
      data?.bpInTargetPct30d,
      data?.bpInTargetPctAllTime,
    ].some((pct) => pct != null && pct > 0);

  // Tile (strip) gates — controlled by the new `tileVisible` flag.
  const showWeightTile = isTileVisible("weight") && hasWeight;
  const showBpTiles = isTileVisible("bp") && hasBp;
  const showPulseTile = isTileVisible("pulse") && hasPulse;
  const showBodyFatTile = isTileVisible("bodyFat") && hasBodyFat;
  const showMoodTile = isTileVisible("mood") && hasMood;
  const showSleepTile = isTileVisible("sleep") && hasSleep;
  const showStepsTile = isTileVisible("steps") && hasSteps;
  const showVo2Tile = isTileVisible("vo2Max") && hasVo2;
  const showBpInTargetTile = isTileVisible("bpInTarget") && hasBpInTarget;

  // Chart (lower row) gates — controlled by the legacy `visible` flag.
  const showWeightChart = isChartVisible("weight") && hasWeight;
  const showBpCharts = isChartVisible("bp") && hasBp;
  const showPulseChart = isChartVisible("pulse") && hasPulse;
  const showBodyFatChart = isChartVisible("bodyFat") && hasBodyFat;
  const showMoodChart = isChartVisible("mood") && hasMood;
  const showSleepChart = isChartVisible("sleep") && hasSleep;
  const showStepsChart = isChartVisible("steps") && hasSteps;
  const showMedicationsCard = isChartVisible("medications");
  // `layoutData` is undefined until the real layout (snapshot or legacy
  // widgets) resolves; `resolveDashboardLayout(undefined)` falls back to
  // DEFAULT_DASHBOARD_LAYOUT, where `achievements` is visible by default.
  // Gating layout-toggle-only cards on that fallback flashed them in for
  // the load window and then retracted them for any user who had turned
  // the widget OFF (their real layout arriving after first paint). The
  // data-driven tiles tolerate the fallback because they also gate on a
  // data floor; the achievements + recent-workouts cards have no floor,
  // so wait for the real layout before committing them.
  const layoutResolved = layoutData != null;
  // v1.4.15 phase-B4 — recent unlocks dashboard surface. The card itself
  // self-handles the loading skeleton + empty state (CTA → /achievements),
  // so we only need the layout-toggle gate here. No data-floor check (the
  // empty card is intentional — the maintainer wants the user to discover
  // the feature).
  const showAchievementsCard = layoutResolved && isChartVisible("achievements");
  // v1.4.32 — recent workouts dashboard tile. Self-gates on the
  // workouts query response so we only need the layout toggle here;
  // the tile renders an Apple-Health-onboarding hint when empty. Same
  // layout-resolved gate as the achievements card — default-visible with
  // no data floor, so it would otherwise flash in then retract for a user
  // who hid it.
  const showRecentWorkoutsTile =
    layoutResolved && isChartVisible("recentWorkouts");

  // v1.16.0 — shared reveal gate for the chart row. Every data-backed
  // chart mounts as soon as its visibility gate flips (so the per-chart
  // queries fan out in parallel), but the cells hold their layout-stable
  // skeletons until EVERY gated chart reported its data settled — or the
  // 2 s timeout fires so one slow widget cannot block the row (see
  // `chart-reveal.tsx`). Pre-fix the cheap `/api/mood/analytics` read
  // made the mood chart paint first and the measurement charts trickle
  // in one after another. The id list mirrors the `charts[]` entry ids
  // below; the achievements + recent-workouts cards stay outside the
  // gate (they self-skeleton and carry no chart-shaped footprint).
  const revealChartIds: string[] = [];
  if (showWeightChart) {
    revealChartIds.push("weight-chart");
    if (user?.heightCm) revealChartIds.push("bmi-chart");
  }
  if (showBpCharts) revealChartIds.push("bp-chart");
  if (showPulseChart) revealChartIds.push("pulse-chart");
  if (showBodyFatChart) revealChartIds.push("bodyFat-chart");
  if (showMoodChart) revealChartIds.push("mood-chart");
  if (showSleepChart) revealChartIds.push("sleep-chart");
  if (showStepsChart) revealChartIds.push("steps-chart");
  if (showMedicationsCard) revealChartIds.push("medications");
  const { revealed: chartsRevealed, markReady: markChartReady } =
    useDashboardChartReveal(revealChartIds);

  // Glucose widget — visible iff layout enables it AND at least one reading exists.
  // Glucose has no separate chart slot today, so the tile flag is the
  // single source of truth for it.
  const glucoseWidgetVisible = isTileVisible("glucose");
  const displayGlucoseUnit = resolveGlucoseUnit(user?.glucoseUnit ?? null);
  const glucoseByContext = data?.glucoseByContext ?? {};
  const glucoseContexts = [
    "FASTING",
    "POSTPRANDIAL",
    "RANDOM",
    "BEDTIME",
  ] as const;
  const glucoseSummariesPresent = glucoseContexts.filter(
    (ctx) => (glucoseByContext[ctx]?.count ?? 0) > 0,
  );
  const showGlucoseCards =
    glucoseWidgetVisible && glucoseSummariesPresent.length > 0;
  const glucoseLabelKey: Record<string, string> = {
    FASTING: "targets.glucoseFasting",
    POSTPRANDIAL: "targets.glucosePostprandial",
    RANDOM: "targets.glucoseRandom",
    BEDTIME: "targets.glucoseBedtime",
  };
  const bpTargets =
    user?.dateOfBirth != null ? getBpTargets(new Date(user.dateOfBirth)) : null;
  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    (user?.gender as "MALE" | "FEMALE" | null | undefined) ?? null,
  );
  const bodyFatRange = getBodyFatTargetRange(user?.gender);
  const weightRange = user?.heightCm
    ? buildWeightRangeFromHeight(user.heightCm)
    : null;
  const weightBands = user?.heightCm
    ? buildWeightBandsFromHeight(user.heightCm, {
        lowerBound: 30,
        upperBound: 250,
      })
    : undefined;
  const bpTargetZones = bpTargets
    ? [
        {
          min: bpTargets.sysLow,
          max: bpTargets.sysHigh,
          color: "#ff79c6",
          opacity: 0.21,
          label: t("charts.systolic"),
          textColor: "#ff79c6",
          lineOpacity: 0.24,
        },
        {
          min: bpTargets.diaLow,
          max: bpTargets.diaHigh,
          color: "#8be9fd",
          opacity: 0.21,
          label: t("charts.diastolic"),
          textColor: "#8be9fd",
          lineOpacity: 0.24,
        },
      ]
    : undefined;
  const bpSysRange = bpTargets
    ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh)
    : null;
  const bpDiaRange = bpTargets
    ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh)
    : null;
  const pulseDisplayRange = {
    greenMin: pulseTarget.greenMin,
    greenMax: pulseTarget.greenMax,
    orangeMin: pulseTarget.orangeMin,
    orangeMax: pulseTarget.orangeMax,
  };
  const pulseBands = [
    { min: 30, max: pulseTarget.orangeMin, color: "#ff5555", opacity: 0.16 },
    {
      min: pulseTarget.orangeMin,
      max: pulseTarget.greenMin,
      color: "#ffb86c",
      opacity: 0.18,
    },
    {
      min: pulseTarget.greenMin,
      max: pulseTarget.greenMax,
      color: "#50fa7b",
      opacity: 0.2,
    },
    {
      min: pulseTarget.greenMax,
      max: pulseTarget.orangeMax,
      color: "#ffb86c",
      opacity: 0.18,
    },
    { min: pulseTarget.orangeMax, max: 220, color: "#ff5555", opacity: 0.16 },
  ].filter((band) => band.max > band.min);
  const bodyFatBands = buildTrafficLightBands(
    bodyFatRange.min,
    bodyFatRange.max,
    {
      lowerBound: 2,
      upperBound: 55,
    },
  );
  // v1.4.40 W-RSC — memoise the per-render `Intl.DateTimeFormat`
  // instantiation (audit-H4). The greeting derived from the hour only
  // changes when the user's timezone changes; recomputing it every
  // render churned the parts-array and walked the format ICU twice per
  // render across a 1 400-line component body.
  const userTimezone = user?.timezone;
  const hour = useMemo(
    () => (userTimezone ? getHourForTimeZone(userTimezone) : null),
    [userTimezone],
  );
  const timeGreeting =
    hour == null
      ? t("dashboard.greeting.day")
      : hour >= 5 && hour < 12
        ? t("dashboard.greeting.morning")
        : hour >= 12 && hour < 18
          ? t("dashboard.greeting.day")
          : t("dashboard.greeting.evening");
  const welcomeText =
    user?.username && user.username.trim().length > 0
      ? t("dashboard.welcomeBackWithName", {
          greeting: timeGreeting,
          name: user.username,
        })
      : t("dashboard.welcomeBack", { greeting: timeGreeting });

  return (
    <div className="space-y-6">
      <DashboardHeader
        welcomeText={welcomeText}
        onQuickEntry={setQuickEntryDialog}
      />

      {/* v1.4: Getting-started checklist for brand-new users.
       * Self-gates visibility on (onboardingCompletedAt == null
       * || measurementCount < 5) and disappears once dismissed
       * or fully complete. See B2 in the v1.4 discovery summary. */}
      <GettingStartedChecklist />

      {/* v1.4.15 Phase B5 — spotlight tour for first-time users.
       * Self-gates on `user.onboardingTourCompleted` (DB flag) plus
       * a session-storage dismiss guard. We pass `ready=true` only
       * after analytics has resolved — the tour anchors to the tile
       * strip and we don't want the cutout snapping to a 0×0
       * placeholder before tiles render. The launcher mounts a no-op
       * `null` when the user has already seen the tour, so this
       * line is free for established users. */}
      <TourLauncher ready={data !== undefined} />

      {/* Quick Entry Sheets — bottom-sheet on `<md`, centred Dialog on `md+`. */}
      <QuickEntrySheets
        open={quickEntryDialog}
        onClose={() => setQuickEntryDialog(null)}
      />

      {(() => {
        type TrendEntry = { id: string; order: number; node: React.ReactNode };
        const trendCards: TrendEntry[] = [];

        if (showWeightTile) {
          trendCards.push({
            id: "weight",
            order: widgetOrder("weight"),
            node: (
              <TrendCard
                key="weight"
                label={t("dashboard.weightShort")}
                latest={w?.latest ?? null}
                unit="kg"
                avg7={w?.avg7 ?? null}
                avg30={w?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(w?.avg7, {
                  range: weightRange,
                })}
                avg30ColorClass={getRangeColorClass(w?.avg30, {
                  range: weightRange,
                })}
                avg7Hint={getRangeHint(
                  "kg",
                  { range: weightRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "kg",
                  { range: weightRange },
                  t,
                  fmt.number,
                )}
                slope30={w?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(w)}
                icon={Activity}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(w)}
                staleDays={tileStaleDays("WEIGHT")}
              />
            ),
          });
        }
        if (showBpTiles) {
          // BP is conceptually one signal but visually two tiles (sys + dia)
          // so the user sees both numbers side by side at the same size as
          // every other tile in the strip. v1.4.3 first attempted a
          // combined tile with `secondary` values — the maintainer preferred two
          // distinct tiles with consistent symmetric widths.
          trendCards.push({
            id: "bp-sys",
            order: widgetOrder("bp"),
            node: (
              <TrendCard
                key="bp-sys"
                label={t("dashboard.bloodPressureSysShort")}
                latest={sys?.latest ?? null}
                unit="mmHg"
                avg7={sys?.avg7 ?? null}
                avg30={sys?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(sys?.avg7, {
                  range: bpSysRange,
                })}
                avg30ColorClass={getRangeColorClass(sys?.avg30, {
                  range: bpSysRange,
                })}
                avg7Hint={getRangeHint(
                  "mmHg",
                  { range: bpSysRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "mmHg",
                  { range: bpSysRange },
                  t,
                  fmt.number,
                )}
                slope30={sys?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(sys)}
                icon={Heart}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(sys)}
                staleDays={tileStaleDays("BLOOD_PRESSURE_SYS")}
              />
            ),
          });
          trendCards.push({
            id: "bp-dia",
            // Sub-order keeps dia immediately after sys; the +0.001 leaves
            // headroom for any future BP-related tile slotted between them.
            order: widgetOrder("bp") + 0.001,
            node: (
              <TrendCard
                key="bp-dia"
                label={t("dashboard.bloodPressureDiaShort")}
                latest={dia?.latest ?? null}
                unit="mmHg"
                avg7={dia?.avg7 ?? null}
                avg30={dia?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(dia?.avg7, {
                  range: bpDiaRange,
                })}
                avg30ColorClass={getRangeColorClass(dia?.avg30, {
                  range: bpDiaRange,
                })}
                avg7Hint={getRangeHint(
                  "mmHg",
                  { range: bpDiaRange },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "mmHg",
                  { range: bpDiaRange },
                  t,
                  fmt.number,
                )}
                slope30={dia?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(dia)}
                icon={Heart}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(dia)}
                staleDays={tileStaleDays("BLOOD_PRESSURE_DIA")}
              />
            ),
          });
        }
        if (showPulseTile) {
          trendCards.push({
            id: "pulse",
            order: widgetOrder("pulse"),
            node: (
              <TrendCard
                key="pulse"
                label={t("dashboard.pulseShort")}
                latest={pulseTileSummary?.latest ?? null}
                unit="bpm"
                avg7={pulseTileSummary?.avg7 ?? null}
                avg30={pulseTileSummary?.avg30 ?? null}
                avg7ColorClass={getRangeColorClass(pulseTileSummary?.avg7, {
                  range: hasRestingHr ? pulseDisplayRange : null,
                })}
                avg30ColorClass={getRangeColorClass(pulseTileSummary?.avg30, {
                  range: hasRestingHr ? pulseDisplayRange : null,
                })}
                avg7Hint={getRangeHint(
                  "bpm",
                  { range: hasRestingHr ? pulseDisplayRange : null },
                  t,
                  fmt.number,
                )}
                avg30Hint={getRangeHint(
                  "bpm",
                  { range: hasRestingHr ? pulseDisplayRange : null },
                  t,
                  fmt.number,
                )}
                slope30={pulseTileSummary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(pulseTileSummary)}
                icon={TrendingUp}
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(pulseTileSummary)}
                staleDays={tileStaleDays(
                  hasRestingHr ? "RESTING_HEART_RATE" : "PULSE",
                )}
              />
            ),
          });
        }
        if (showBodyFatTile) {
          trendCards.push({
            id: "bodyFat",
            order: widgetOrder("bodyFat"),
            node: (
              <TrendCard
                key="bodyFat"
                label={t("dashboard.bodyFatShort")}
                latest={bf?.latest ?? null}
                unit="%"
                avg7={bf?.avg7 ?? null}
                avg30={bf?.avg30 ?? null}
                slope30={bf?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(bf)}
                icon={Percent}
                directionSentiment="up-bad"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(bf)}
                staleDays={tileStaleDays("BODY_FAT")}
              />
            ),
          });
        }
        if (showMoodTile) {
          trendCards.push({
            id: "mood",
            order: widgetOrder("mood"),
            node: (
              <TrendCard
                key="mood"
                label={t("dashboard.moodShort")}
                latest={moodSummary?.latest ?? null}
                unit="/ 5"
                avg7={moodSummary?.avg7 ?? null}
                avg30={moodSummary?.avg30 ?? null}
                slope30={moodSummary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(moodSummary)}
                icon={Smile}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(moodSummary)}
              />
            ),
          });
        }
        if (showSleepTile) {
          trendCards.push({
            id: "sleep",
            order: widgetOrder("sleep"),
            node: (
              <TrendCard
                key="sleep"
                label={t("dashboard.sleepShort") ?? "Sleep"}
                latest={sleepSummaryHours?.latest ?? null}
                unit="h"
                avg7={sleepSummaryHours?.avg7 ?? null}
                avg30={sleepSummaryHours?.avg30 ?? null}
                slope30={sleepSummaryHours?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(sleepSummaryHours)}
                icon={Moon}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(sleepSummaryHours)}
                staleDays={tileStaleDays("SLEEP_DURATION")}
              />
            ),
          });
        }
        if (showStepsTile) {
          trendCards.push({
            id: "steps",
            order: widgetOrder("steps"),
            node: (
              <TrendCard
                key="steps"
                label={t("dashboard.stepsShort") ?? "Steps"}
                latest={stepsSummary?.latest ?? null}
                unit=""
                avg7={stepsSummary?.avg7 ?? null}
                avg30={stepsSummary?.avg30 ?? null}
                slope30={stepsSummary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(stepsSummary)}
                icon={Footprints}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(stepsSummary)}
                staleDays={tileStaleDays("ACTIVITY_STEPS")}
              />
            ),
          });
        }
        // v1.4.25 W8d — VO2 max trend tile. Self-gates on the
        // `vo2Max` widget being enabled (Settings → Dashboard) AND
        // the analytics summary carrying at least one sample. Higher
        // VO2 max is better, so the directionSentiment is up-good and
        // an upward 30-day slope renders the green arrow. Unit
        // matches the canonical DB unit in
        // src/lib/validations/measurement.ts.
        if (showVo2Tile) {
          trendCards.push({
            id: "vo2Max",
            order: widgetOrder("vo2Max"),
            node: (
              <TrendCard
                key="vo2Max"
                label={t("dashboard.vo2MaxShort") ?? "VO₂ max"}
                latest={vo2Summary?.latest ?? null}
                unit={t("dashboard.vo2MaxUnit") ?? "mL/(kg·min)"}
                avg7={vo2Summary?.avg7 ?? null}
                avg30={vo2Summary?.avg30 ?? null}
                slope30={vo2Summary?.slope30 ?? null}
                trend7Delta={summaryToTrend7Delta(vo2Summary)}
                icon={Gauge}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={tileCompareDelta(vo2Summary)}
                staleDays={tileStaleDays("VO2_MAX")}
              />
            ),
          });
        }
        if (showBpInTargetTile) {
          /* v1.4.22 A2 — feature parity with every other tile.
             Synthesise a slope from the difference between the 7-day
             and 30-day in-target shares: when the recent week is
             above the recent month, the metric is improving (up-good
             ⇒ green arrow); when below, it's slipping. The
             trend7Delta is the same number as the arrow's underlying
             signal, surfaced as "(+5)" next to `7d:` so the tile
             matches the (weight / BP / pulse) call-site contract.
             Comparison overlay routes through the same global
             `compareBaseline` / `tileCompareDelta` pipeline as every
             other tile; we only have a single % series for the BP
             tile (no DataSummary) so the prior-period delta uses
             `bpInTargetPctAllTime` as the long-arc baseline — when
             comparison is off the field stays null. */
          // v1.4.28 FB-C1 + FB-C2 — rewrite the BD-Zielbereich tile
          // against the shared `<TrendCard>` primitive so it matches
          // the Weight / BP / Pulse sibling tiles exactly. The
          // synthetic `bpSlope30 = bpTrendDelta / 30` block produced a
          // small fractional float that the TrendCard's date-shaped
          // formatter pipeline rendered as "1.1." — the regression the
          // maintainer flagged in the post-v1.4.27 walk-through. The
          // all-time aggregate moves to the Insights blood-pressure
          // target panel which already shows the same number with more
          // context; the dashboard tile no longer needs to carry it.
          // `avgAllTime`
          // also retires from the TrendCard API (this was its only
          // consumer).
          const bp7 = data?.bpInTargetPct7d ?? null;
          const bp30 = data?.bpInTargetPct30d ?? null;
          const bpPriorMonth = data?.bpInTargetPctPriorMonth ?? null;
          const bpPriorYear = data?.bpInTargetPctPriorYear ?? null;
          const bpTrendDelta =
            bp7 !== null && bp30 !== null ? bp7 - bp30 : null;
          const bpComparePrior =
            compareBaseline === "lastMonth"
              ? bpPriorMonth
              : compareBaseline === "lastYear"
                ? bpPriorYear
                : null;
          const bpCompareDelta =
            compareBaseline === "none" ||
            bp30 === null ||
            bpComparePrior === null
              ? null
              : Math.round((bp30 - bpComparePrior) * 10) / 10;
          trendCards.push({
            id: "bpInTarget",
            order: widgetOrder("bpInTarget"),
            node: (
              <TrendCard
                key="bpInTarget"
                label={t("dashboard.bpInTargetShort")}
                latest={data?.bpInTargetPct ?? null}
                unit="%"
                avg7={bp7}
                avg30={bp30}
                slope30={null}
                trend7Delta={bpTrendDelta}
                icon={Target}
                directionSentiment="up-good"
                compareBaseline={compareBaseline}
                compareDelta={bpCompareDelta}
              />
            ),
          });
        }
        if (showGlucoseCards) {
          const glucoseOrder = widgetOrder("glucose");
          glucoseSummariesPresent.forEach((ctx, idx) => {
            const s = glucoseByContext[ctx];
            trendCards.push({
              id: `glucose-${ctx}`,
              // sub-order so all glucose cards stay in a block and order stable
              order: glucoseOrder + idx / 1000,
              node: (
                <TrendCard
                  key={`glucose-${ctx}`}
                  label={t(glucoseLabelKey[ctx])}
                  latest={
                    s.latest != null
                      ? convertGlucose(s.latest, displayGlucoseUnit)
                      : null
                  }
                  unit={displayGlucoseUnit}
                  avg7={
                    s.avg7 != null
                      ? convertGlucose(s.avg7, displayGlucoseUnit)
                      : null
                  }
                  avg30={
                    s.avg30 != null
                      ? convertGlucose(s.avg30, displayGlucoseUnit)
                      : null
                  }
                  slope30={s.slope30 ?? null}
                  icon={Droplet}
                  staleDays={tileStaleDays("BLOOD_GLUCOSE")}
                />
              ),
            });
          });
        }

        trendCards.sort((a, b) => a.order - b.order);

        type ChartEntry = {
          id: string;
          order: number;
          node: React.ReactNode;
          /**
           * Total raw readings for this metric. <5 surfaces a contextual
           * "First trend after 5 readings" hint underneath the chart;
           * undefined disables the hint (e.g. medications card).
           */
          count?: number;
          /**
           * v1.16.0 — entry participates in the shared chart reveal:
           * the cell holds its skeleton until every gated chart's data
           * settled (or the 2 s fallback fires). Data-backed charts set
           * this; the self-skeletoning achievements / recent-workouts
           * cards do not.
           */
          revealGated?: boolean;
        };
        const charts: ChartEntry[] = [];
        if (showWeightChart) {
          charts.push({
            id: "weight-chart",
            order: widgetOrder("weight"),
            count: w?.count ?? 0,
            revealGated: true,
            node: (
              <HealthChartDynamic
                key="weight-chart"
                onDataReady={() => markChartReady("weight-chart")}
                chartKey="weight"
                types={["WEIGHT"]}
                title={t("dashboard.weight")}
                colors={["#bd93f9"]}
                unit="kg"
                valueBands={weightBands}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
          if (user?.heightCm) {
            charts.push({
              id: "bmi-chart",
              order: widgetOrder("weight") + 0.5,
              revealGated: true,
              node: (
                <HealthChartDynamic
                  key="bmi-chart"
                  onDataReady={() => markChartReady("bmi-chart")}
                  chartKey="bmi"
                  types={["WEIGHT"]}
                  title={t("targets.bmi")}
                  colors={["#f1fa8c"]}
                  unit="kg/m²"
                  valueMode="bmi"
                  valueBands={[
                    { min: 0, max: 17, color: "#ff5555", opacity: 0.16 },
                    { min: 17, max: 18.5, color: "#ffb86c", opacity: 0.18 },
                    { min: 18.5, max: 24.9, color: "#50fa7b", opacity: 0.2 },
                    { min: 24.9, max: 29.9, color: "#ffb86c", opacity: 0.18 },
                    { min: 29.9, max: 120, color: "#ff5555", opacity: 0.16 },
                  ]}
                  compareBaseline={compareBaseline}
                />
              ),
            });
          }
        }
        if (showBpCharts) {
          charts.push({
            id: "bp-chart",
            order: widgetOrder("bp"),
            count: Math.max(sys?.count ?? 0, dia?.count ?? 0),
            revealGated: true,
            node: (
              <HealthChartDynamic
                key="bp-chart"
                onDataReady={() => markChartReady("bp-chart")}
                chartKey="bp"
                types={["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"]}
                title={t("dashboard.bloodPressure")}
                colors={["#ff79c6", "#8be9fd"]}
                unit="mmHg"
                yAxisUnit="Hg"
                targetZones={bpTargetZones}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showPulseChart) {
          charts.push({
            id: "pulse-chart",
            order: widgetOrder("pulse"),
            count: p?.count ?? 0,
            revealGated: true,
            node: (
              <HealthChartDynamic
                key="pulse-chart"
                onDataReady={() => markChartReady("pulse-chart")}
                chartKey="pulse"
                // v1.15.12 A2 — chart the RESTING series against the
                // resting band when available; otherwise chart raw heart
                // rate WITHOUT the resting-band overlay (it would mark
                // expected-high workout HR as "outside target").
                types={hasRestingHr ? ["RESTING_HEART_RATE"] : ["PULSE"]}
                title={t("dashboard.pulse")}
                colors={["#50fa7b"]}
                unit="bpm"
                valueBands={hasRestingHr ? pulseBands : undefined}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showBodyFatChart) {
          charts.push({
            id: "bodyFat-chart",
            order: widgetOrder("bodyFat"),
            count: bf?.count ?? 0,
            revealGated: true,
            node: (
              <HealthChartDynamic
                key="bodyFat-chart"
                onDataReady={() => markChartReady("bodyFat-chart")}
                chartKey="bodyFat"
                types={["BODY_FAT"]}
                title={t("dashboard.bodyFat")}
                colors={["#ffb86c"]}
                unit="%"
                valueBands={bodyFatBands}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showMoodChart) {
          charts.push({
            id: "mood-chart",
            order: widgetOrder("mood"),
            count: moodSummary?.count ?? 0,
            revealGated: true,
            node: (
              <MoodChart
                key="mood-chart"
                onDataReady={() => markChartReady("mood-chart")}
                compareBaseline={compareBaseline}
                chartKey="mood"
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showSleepChart) {
          charts.push({
            id: "sleep-chart",
            order: widgetOrder("sleep"),
            count: sleepSummary?.count ?? 0,
            revealGated: true,
            node: (
              <HealthChartDynamic
                key="sleep-chart"
                onDataReady={() => markChartReady("sleep-chart")}
                chartKey="sleep"
                types={["SLEEP_DURATION"]}
                title={t("dashboard.sleep") ?? "Sleep"}
                colors={["#8be9fd"]}
                unit="h"
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showStepsChart) {
          charts.push({
            id: "steps-chart",
            order: widgetOrder("steps"),
            count: stepsSummary?.count ?? 0,
            revealGated: true,
            node: (
              <HealthChartDynamic
                key="steps-chart"
                onDataReady={() => markChartReady("steps-chart")}
                chartKey="steps"
                types={["ACTIVITY_STEPS"]}
                title={t("dashboard.steps") ?? "Steps"}
                colors={["#50fa7b"]}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showMedicationsCard) {
          // v1.4.15 Fix 2: the toggle existed since v1.1 but the dashboard
          // slot only rendered a static placeholder (icon + title), so
          // flipping the layout switch on did nothing visible. Wire the
          // real chart that consumes
          // `/api/medications/intake?scope=compliance&days=N`.
          charts.push({
            id: "medications",
            order: widgetOrder("medications"),
            revealGated: true,
            node: (
              <MedicationComplianceChart
                key="medications"
                onDataReady={() => markChartReady("medications")}
                compareBaseline={compareBaseline}
                userTimezone={user?.timezone}
              />
            ),
          });
        }
        if (showAchievementsCard) {
          // v1.4.15 phase-B4 — slotted at the user's chosen position via
          // the layout `order`. Default order from
          // `DEFAULT_DASHBOARD_LAYOUT` puts it last (below the chart row)
          // which matches the maintainer's brief "below the chart row".
          charts.push({
            id: "achievements",
            order: widgetOrder("achievements"),
            node: <RecentAchievementsCard key="achievements" />,
          });
        }
        if (showRecentWorkoutsTile) {
          // v1.4.32 — slotted via the same `order` mechanism. Self-gates
          // on the workouts query response inside the tile itself.
          charts.push({
            id: "recentWorkouts",
            order: widgetOrder("recentWorkouts"),
            node: <RecentWorkoutsTile key="recentWorkouts" />,
          });
        }

        charts.sort((a, b) => a.order - b.order);

        // v1.4.43 W11-M5 — tile-strip skeleton during slow slim-analytics
        // fetches.
        //
        // `trendCards` only fills once the slim `/api/analytics` slice
        // resolves and reports per-type `count > 0` flags. The v1.4.39.2
        // slim/thick split keeps the strip painting fast when slim wins,
        // but when *both* slices lag (cache eviction, cold start) the
        // user used to see the page header + 0 tiles + then 7 tiles
        // appear at once 9 s later. The audit recommendation is to
        // render a layout-stable tile silhouette keyed off the user's
        // configured tile count so the strip's footprint is reserved
        // during the slow window. The skeleton swaps in for the real
        // strip the moment `analyticsSlimQuery.isLoading` flips false.
        // v1.7.0 — count only WEB-known tiles. The stored layout now
        // round-trips the 11 iOS-only ids (so the native client can drop
        // its merge workarounds), but the web dashboard has no tile
        // component for them; including them here would over-reserve the
        // skeleton silhouette by rows that never paint.
        const webWidgetIds = new Set<string>(DASHBOARD_WIDGET_IDS);
        const configuredTileCount = layout.widgets.filter(
          (w) => webWidgetIds.has(w.id) && (w.tileVisible ?? w.visible),
        ).length;
        // v1.7.0 — the primary data source differs by flag. In snapshot
        // mode `analyticsSlimQuery` is `enabled: false`, and a disabled
        // TanStack query reports `fetchStatus: "idle"` → `isLoading` is
        // always `false`. Gating the skeleton on the slim query then
        // never fires under snapshot mode, so the empty-state branch
        // below flashes for the whole snapshot fetch. Key the loading
        // flag off whichever query is actually driving the tiles.
        const primaryLoading = snapshotEnabled
          ? snapshotQuery.isLoading
          : analyticsSlimQuery.isLoading;
        const { showTileStripSkeleton, showEmptyState } =
          resolveDashboardFirstPaintGate({
            trendCardCount: trendCards.length,
            chartCount: charts.length,
            configuredTileCount,
            primaryLoading,
          });

        // v1.4.15 phase-C5: dashboard fully-empty state. When no tile
        // and no chart has data the dashboard would otherwise paint a
        // 0-px tile strip with the welcome banner above it — visually
        // looked like a half-broken page. Render an EmptyState that
        // re-uses the existing quick-entry dialog so the user has a
        // single click into "Log measurement" without leaving the page.
        // The GettingStartedChecklist above renders its own self-gated
        // surface for very-new accounts; this empty state covers the
        // case where the checklist has been dismissed but no data was
        // logged afterwards.
        //
        // v1.4.43 W11 — the empty-state only fires once the slim slice
        // resolves with no tiles to show. While slim is in flight the
        // skeleton strip below carries the layout footprint.
        if (showEmptyState) {
          return (
            <EmptyState
              icon={<Activity className="size-6" />}
              title={t("dashboard.emptyTitle")}
              description={t("dashboard.emptyDescription")}
              action={
                <Button
                  size="sm"
                  onClick={() => setQuickEntryDialog("measurement")}
                >
                  <Plus className="h-4 w-4" />
                  {t("dashboard.emptyAddMeasurement")}
                </Button>
              }
            />
          );
        }

        return (
          <>
            {/* v1.4: dashboard tiles are *always* a single row.
             * Maintainer-explicit (per feedback_dashboard_one_row.md): a 2-row
             * tile strip breaks the visual hierarchy and reads like an
             * Excel grid. Total width caps at the parent container —
             * exactly the chart-width below. When the active tile count
             * exceeds what fits the viewport, the strip horizontal-scrolls
             * instead of wrapping; the user trims the set in
             * Settings → Dashboard (`/settings/dashboard`).
             * Each tile keeps a `min-w-[10rem]` so a single tile still
             * looks substantial on a wide screen, and `snap-x snap-mandatory`
             * makes the scroll feel deliberate rather than arbitrary on
             * touch.
             */}
            {/* v1.4.16 Fix A5: hide the strip entirely when the user
                turned off every tile. Until v1.4.15 the wrapper rendered
                an empty grid even with zero tiles — visually a thin gap
                the maintainer described as "awkward". Charts below still render so
                the page is not empty; the tile-strip just goes away.
                The constraint the maintainer named — "immer die gesamte Spalte
                breit und immer der gleichen Höhe" — is preserved by the
                CSS-grid `auto-fit + minmax + auto-rows-fr` track that
                continues to give every visible tile equal width / equal
                height for any non-zero count. */}
            {showTileStripSkeleton && (
              <div
                // v1.4.43 W11-M5 — tile-strip skeleton mirrors the real
                // grid track (`auto-fit minmax(min(100%,11rem),1fr)`) so
                // the layout footprint is reserved while slim-analytics
                // is in flight. Cards are keyed off the user's
                // configured tile count (`configuredTileCount`) — if the
                // user trimmed the strip to 3 tiles in Settings, the
                // skeleton shows 3 silhouettes, not 7.
                aria-hidden="true"
                data-slot="dashboard-tile-strip-skeleton"
                className={cn(
                  "grid auto-rows-fr gap-3",
                  "[grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]",
                )}
              >
                {/* v1.16.0 — structured silhouettes (label + headline
                    value + sub-row, see `<TrendCardSkeleton>`) instead
                    of the former EMPTY pulsing cards, so the first
                    paint previews the final tile shape. Reduced motion
                    is honoured inside the component via the Skeleton
                    primitive's motion-reduce:animate-none. */}
                {Array.from({ length: configuredTileCount }).map((_, idx) => (
                  <TrendCardSkeleton key={`tile-skeleton-${idx}`} />
                ))}
              </div>
            )}
            {trendCards.length > 0 && (
              <div
                // v1.4.33 A3 Win 2 + F3 — collapse the bifurcated
                // mobile-flex / desktop-grid layout into one
                // responsive grid track. The v1.4.27 MB7 fix pinned a
                // `flex overflow-x-auto` row at `<sm` so tiles
                // scrolled horizontally rather than wrapping to 3-4
                // rows on a 280 px Galaxy Fold; the v1.4.33 audit
                // (Win 2) called the side-scroll an unwanted
                // regression for the Pixel 5 / iPhone-13-mini
                // viewports where two tiles per row fit naturally.
                // One grid track for every breakpoint:
                //
                //   `repeat(auto-fit, minmax(min(100%, 11rem), 1fr))`
                //
                // - Galaxy Fold (280 px) → 1 column, tiles stretch
                //   full width.
                // - Pixel 5 / iPhone-13-mini (375 px) → 2 columns,
                //   strip wraps to a second row when needed.
                // - 1440×900 desktop → 6 columns (1440 / 220 ≈ 6.5),
                //   widens the value column from the v1.4.27
                //   `9rem` floor so the headline number stops
                //   truncating to `8…` / `1.` (audit F3). 11 rem
                //   ≈ 176 px gives every tile ~220 px including
                //   gutter — comfortably wider than `text-3xl`
                //   digits plus the unit + arrow.
                // - 1920+ desktop → 8 columns, no horizontal slack.
                //
                // `auto-rows-fr` keeps the row height deterministic
                // so a 7-tile run still shares one baseline across
                // the wrap, regardless of which tile renders a
                // callout.
                className={cn(
                  "grid auto-rows-fr gap-3",
                  "[grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))]",
                )}
                data-slot="dashboard-tile-strip"
                data-tour-id="dashboard-tile-strip"
                data-tile-count={trendCards.length}
              >
                {trendCards.map((entry) => (
                  <div key={entry.id} className="flex min-w-0">
                    {/*
                     * Per-tile `<Suspense>` boundary with a layout-stable
                     * placeholder that mirrors the trend-card chrome. Tile
                     * bodies are synchronous today so the fallback rarely
                     * paints, but a future RSC hoist of any tile slot
                     * would otherwise leave the grid track empty and
                     * trigger CLS as the cell paints in.
                     *
                     * v1.4.40 W-RSC — boundary added; v1.4.41 W-FRONTEND-FACTORY — fallback hoisted to layout-stable placeholder.
                     */}
                    {/* v1.16.0 — the fallback is the same structured
                        silhouette the tile-strip skeleton paints, so a
                        suspending tile slot previews the final shape
                        instead of an empty card. */}
                    <Suspense fallback={<TrendCardSkeleton />}>
                      {entry.node}
                    </Suspense>
                  </div>
                ))}
              </div>
            )}
            {charts.map((entry) => (
              <div key={entry.id} className="space-y-2">
                {/*
                 * v1.4.40 W-RSC — per-tile `<Suspense>` boundary so each
                 * chart paints independently rather than the row blocking
                 * on the slowest fetch (audit-H2 + brief C1). The
                 * `next/dynamic({ ssr: false })` lazy-load contract on
                 * `HealthChartDynamic` / `MoodChart` /
                 * `MedicationComplianceChart` already paints a
                 * `<ChartSkeleton>` while the JS chunk is in flight; this
                 * Suspense layer lifts the same skeleton to a streaming-
                 * compatible boundary so a future migration to
                 * `useSuspenseQuery` (when we replace the per-chart
                 * `["chart-data", …]` fetches with the slim-analytics-
                 * derived store) automatically buckets each chart's
                 * loading state to its own cell, with no further
                 * call-site changes.
                 *
                 * Today, the boundary is a structural no-op for the
                 * dynamic-loaded charts because their loading skeleton
                 * lives inside the dynamic factory. The benefit is
                 * future-proofing the composition: any descendant that
                 * later suspends (e.g. an RSC migration of a static
                 * legend, or a server-streamed sparkline) gets its own
                 * fallback without re-architecting the row.
                 */}
                {entry.revealGated ? (
                  /* v1.16.0 — gated cell: the chart mounts (its query
                     fires) but stays visually on the layout-stable
                     skeleton until the shared reveal flips — all gated
                     charts swap in the same frame with one short
                     fade-in (motion-safe). The TrendHint rides inside
                     the cell so it appears with its chart. */
                  <DashboardChartCell revealed={chartsRevealed}>
                    <Suspense fallback={<ChartSkeleton />}>
                      {entry.node}
                    </Suspense>
                    {entry.count != null ? (
                      <TrendHint count={entry.count} />
                    ) : null}
                  </DashboardChartCell>
                ) : (
                  <>
                    <Suspense fallback={<ChartSkeleton />}>
                      {entry.node}
                    </Suspense>
                    {entry.count != null ? (
                      <TrendHint count={entry.count} />
                    ) : null}
                  </>
                )}
              </div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
