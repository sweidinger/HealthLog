"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { RefreshCw, TrendingUp } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { HeroStrip } from "@/components/insights/hero-strip";
import { useInsightsAdvisorQuery } from "@/components/insights/use-insights-advisor";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useAnalyticsQuery } from "@/lib/queries/use-analytics-query";
import { useDashboardDerived } from "@/components/insights/derived/use-dashboard-derived";
// v1.4.41 W-ORG — shared shape lives in `src/types/analytics.ts` as
// `InsightsAnalyticsData`; aliased back to the local name to keep the
// rest of this file readable.
import type { InsightsAnalyticsData as AnalyticsData } from "@/types/analytics";

/**
 * v1.4.33 IW2 — defer the below-the-fold mother-page blocks behind
 * `next/dynamic`. `<HeroStrip>` (the only above-the-fold piece) stays an
 * eager import so the initial paint shows the greeting and health-score
 * badge without a flash; the briefing, correlation row and trends row
 * each carry their own icon-set + chart wiring (a chart card alone weighs
 * in at the lucide tree-shake limit) and used to land on every Insights
 * cold mount.
 *
 * v1.11.3 — every loader fallback now routes through the shared
 * `BlockSkeleton` instead of a bespoke `h-[Xrem] animate-pulse` div. The
 * fixed guessed heights pinned each placeholder taller (or shorter) than
 * the resolved block, so the page jumped as each chunk landed. The shared
 * skeleton carries a `min-h` floor — enough to hold the row open at cold
 * mount — and lets the block grow into its true height without fighting a
 * hard-coded pixel guess, killing the resolve-time layout shift. Reduced
 * motion is honoured by the `Skeleton` primitive (`motion-reduce:animate-none`).
 */
function BlockSkeleton({
  minHeight,
  decorative = false,
}: {
  /** Tailwind `min-h-*` utility holding the row open before the chunk lands. */
  minHeight: string;
  /** Decorative placeholders (cards that may un-mount) hide from a11y. */
  decorative?: boolean;
}) {
  return (
    <Skeleton
      {...(decorative ? { "aria-hidden": "true" } : {})}
      className={cn("w-full rounded-xl", minHeight)}
    />
  );
}

const DailyBriefing = dynamic(
  () =>
    import("@/components/insights/daily-briefing").then((mod) => ({
      default: mod.DailyBriefing,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-96" />,
  },
);
const TrendsRow = dynamic(
  () =>
    import("@/components/insights/trends-row").then((mod) => ({
      default: mod.TrendsRow,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-80" />,
  },
);
// v1.12.6 — the wellness-score strip, lifted OUT of the vitals dashboard so
// it renders as its own full-width section directly above the daily briefing.
// Both this strip and the vitals grid read the ONE shared derived batch the
// page owns (passed in via `batch`), so the lift adds no second request.
const WellnessScores = dynamic(
  () =>
    import("@/components/insights/derived").then((mod) => ({
      default: mod.WellnessScores,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-40" decorative />,
  },
);
// v1.10.0 — the Vitals dashboard (Apple-Health-Highlights grid of
// personal-typical-range + passthrough-reframe tiles). Deferred behind
// `next/dynamic` like the other below-the-fold blocks; each tile owns its
// own derived-metric query and un-mounts when its vital is absent.
const VitalsDashboard = dynamic(
  () =>
    import("@/components/insights/derived").then((mod) => ({
      default: mod.VitalsDashboard,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-80" />,
  },
);
// v1.10.0 — categorical events (WX-B). The device-flagged event awareness
// timeline. Deferred like the other below-the-fold blocks; the card
// un-mounts itself when the user has no such events (no skeleton-then-empty
// flash — `ssr: false` + the card's own data gate), so it carries no
// loading placeholder of its own.
const RhythmEventsCard = dynamic(
  () =>
    import("@/components/insights/rhythm-events-card").then((mod) => ({
      default: mod.RhythmEventsCard,
    })),
  { ssr: false },
);
// v1.10.3 — "Today's signal" headline card. Promotes COINCIDENT_DEVIATION from
// a buried below-the-fold tile to the top-of-overview daily read (the
// always-present Apple/WHOOP/Oura pattern). Deferred behind `next/dynamic`; it
// owns its own derived-metric query and renders four calm states. The chunk
// loader's skeleton shares the card's `min-h-48` footprint (and the in-card
// `CardSkeleton` matches it too) so the top of the page does not shift across
// loading → any resolved state. Decorative → `aria-hidden`.
const CoincidentDeviationCard = dynamic(
  () =>
    import("@/components/insights/coincident-deviation-card").then((mod) => ({
      default: mod.CoincidentDeviationCard,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-48" decorative />,
  },
);

// v1.11.0 — period-narrative card (Pillar P1). The calm "your week/month in
// review" summary, drawn from the read-only stale-while-revalidate narrative
// route. Deferred behind `next/dynamic` like the other below-the-hero blocks;
// it owns its own query and un-mounts when no narrative exists. The loader
// skeleton shares the card's `min-h-40` footprint so the page does not shift.
const PeriodNarrativeCard = dynamic(
  () =>
    import("@/components/insights/period-narrative-card").then((mod) => ({
      default: mod.PeriodNarrativeCard,
    })),
  {
    ssr: false,
    loading: () => <BlockSkeleton minHeight="min-h-40" decorative />,
  },
);

/**
 * v1.4.25 W4d — Insights mother page.
 *
 * The page used to be a single 1.8k-LOC monolith that scroll-anchored
 * six per-metric sections beneath the hero. W4a/c carved those out
 * into routed sub-pages under `/insights/{slug}`; this file now holds
 * the overview-only surface:
 *
 *   - The sticky tab strip lives in `src/app/insights/layout.tsx`
 *     (the shared `<InsightsLayoutShell>` mounts it). The strip handles
 *     navigation to every sub-page + the regenerate affordance.
 *   - Hero + DailyBriefing + Trends row + advisor card stay here —
 *     they're the cross-metric overview. The per-metric correlation
 *     cards moved onto the metric pages they belong to (Weight owns
 *     weight × weekday, Pulse owns mood × pulse, …), so the overview
 *     no longer renders a duplicate correlation row.
 *   - The CoachDrawer is mounted in the mother-page body only (Marc
 *     directive). Navigating to a sub-page unmounts the drawer.
 *
 * The per-section status cards (BP/Weight/Pulse/etc.) and their
 * heavy chart wiring moved to the matching sub-pages.
 */

/**
 * The mother page only checks whether the comprehensive payload arrived
 * (the EmptyState gates on `!data`); the metric-specific shape lives on
 * the sub-pages now. Keep this slim — anything more is dead weight here.
 */
interface ComprehensiveData {
  totalMeasurements: number;
}

export default function InsightsPage() {
  const { isAuthenticated, user } = useAuth();
  const { t } = useTranslations();

  // v1.4.33 IW9 — scroll-to-top on route mount centralised in the
  // shared `useScrollResetOnRoute()` hook. The mother page + the
  // `<SubPageShell>` both consume the same hook; the legacy duplicate
  // RAF that lived here pre-v1.4.33 produced a visible double-snap on
  // slow hydrates (chart skeletons inflating between the two
  // callbacks).
  useScrollResetOnRoute();

  // v1.4.27 R3d MB4 — Coach drawer state lives in the layout-level
  // `<CoachLaunchProvider>` so every routed sub-page can reach it.
  // The hero strip + suggested-prompt chips call `askCoach(prefill)`
  // on the same context, and the drawer itself is mounted next to
  // the provider in `src/app/insights/layout.tsx`.
  const coachLaunch = useCoachLaunch();
  const flags = useFeatureFlags();

  // v1.4.36 W1 — drop the page-level `isLoading` gate that used to
  // block the entire shell on `/api/insights/comprehensive`. The
  // comprehensive payload still feeds the empty-state decision but
  // every other section now mounts in parallel under its own
  // <Suspense> boundary, so the user sees the hero + tile skeletons
  // within ~500 ms instead of waiting on the slowest fan-out. The
  // empty-state branch only fires once the query has resolved AND
  // reported zero measurements; while it's in-flight the page paints
  // the regular shell and the tiles fill in as their data lands.
  const { data, isLoading, isFetched, isError, refetch } = useQuery({
    queryKey: queryKeys.insightsComprehensive(),
    queryFn: async () => {
      const res = await fetch("/api/insights/comprehensive");
      if (!res.ok) throw new Error(t("insights.loadError"));
      const json = await res.json();
      return json.data as ComprehensiveData;
    },
    enabled: isAuthenticated,
  });

  // The advisor query is also mounted by the layout shell; the page
  // consumer re-reads from the same cache key so this call is free
  // beyond the React-state subscription.
  const advisor = useInsightsAdvisorQuery(isAuthenticated);

  // v1.4.33 IW2 — the mother page reads `healthScore` (a thick-only
  // field) for the hero score card, so it stays on the default thick
  // slice. The shared hook still centralises the cache settings so the
  // consumer dedups with the sub-page mounts that ride the slim slice
  // instead. Correlations now live on the per-metric pages, so the
  // overview no longer reads `analytics.correlations`.
  const analyticsQuery = useAnalyticsQuery();
  const analytics = analyticsQuery.data as AnalyticsData | undefined;

  // v1.12.6 — the page owns the ONE overview derived batch. The wellness
  // strip (above the briefing) and the vitals grid (below it) both read this
  // single query instance, so the wellness lift adds no second request.
  const dashboardDerived = useDashboardDerived(isAuthenticated);

  // Error branch — a transient 500 / network drop (after the query's
  // retries are exhausted) settles the comprehensive query with no data.
  // Without this gate the page would fall through to the "no data yet —
  // add a measurement" empty-state, which reads false for a user with
  // history. Surface an error + a Retry that refetches the one query,
  // mirroring the <VitalsDashboard> error pattern.
  if (isError) {
    return (
      <div
        data-slot="insights-overview-error"
        role="alert"
        className="bg-card border-border text-muted-foreground flex flex-col items-start gap-3 rounded-xl border p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <span>{t("insights.loadError")}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => refetch()}
          data-slot="insights-overview-retry"
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{t("common.retry")}</span>
        </Button>
      </div>
    );
  }

  // Empty-state shortcut — only paint once the comprehensive query has
  // resolved AND reported zero measurements. While it's in-flight we
  // fall through to the streamed shell so the user gets the hero +
  // skeleton tiles inside the first paint budget.
  if (!isLoading && isFetched && !data) {
    return (
      <EmptyState
        icon={<TrendingUp className="size-6" />}
        title={t("insights.emptyTitle")}
        description={t("insights.emptyDescription")}
        action={
          <Button size="sm" asChild>
            <Link href="/measurements">
              {t("insights.emptyAddMeasurement")}
            </Link>
          </Button>
        }
      />
    );
  }

  const heroGreetingName =
    user?.username?.trim() && user.username.trim().length > 0
      ? user.username.split(/\s+/)[0]
      : null;
  const briefingPayload = advisor.payload?.dailyBriefing ?? null;
  const heroStripUpdatedAt = advisor.payload?.cachedAt ?? null;

  // v1.4.36 QA C2 — no `<Suspense>` wrappers below. The mother page is
  // `"use client"`, the below-the-fold blocks load via `next/dynamic`
  // with `{ ssr: false }` (no Promise-throw on hydrate), and the
  // TanStack Query hooks each return their own loading state without
  // ever throwing a thenable. Wrapping these in `<Suspense>` would be
  // dead code — Suspense never engages and the `loading` props inside
  // each section already drive the skeleton. The perceptual win we
  // ship is "early-skeleton paint": the page-level `isLoading` gate is
  // gone, the hero + each section's own loader skeleton paints inside
  // the first paint budget while data fills in. Genuinely streamed
  // server children would require a Server-Component refactor; that's
  // a v1.5.x track.

  // v1.12.6 — overview section order, top → bottom:
  //   1. "Guten Morgen" Hero + Coach questions (HeroStrip).
  //   2. Wellnesswerte — the wellness-score strip (lifted OUT of
  //      <VitalsDashboard> so it sits ABOVE the briefing as its own
  //      full-width section).
  //   3. "Heute auf einen Blick" briefing (DailyBriefing).
  //   4. Vitalwerte — the vitals grid (+ mobility) inside <VitalsDashboard>,
  //      which no longer renders the wellness strip.
  //   5. Trends (TrendsRow).
  //   6. "Dein Zeitraum im Rückblick" retrospective (PeriodNarrativeCard).
  //   7. "Signale des Tages" — today's signal (CoincidentDeviationCard) plus
  //      the rhythm-events alert timeline, kept out of the AI gate so a
  //      health alert is never hidden.
  // The wellness strip and the vitals grid share the ONE `dashboardDerived`
  // batch the page owns — one request, two sections. The per-metric
  // correlation cards moved onto the metric pages, so the overview renders no
  // correlation row. The duplicate footer "prepare assessments" control was
  // removed in v1.12.4 — the tab-strip regenerate button is the single
  // affordance. The generic disclaimer lives once in the layout-shell footer.
  return (
    // v1.12.7 (L3) — one consistent vertical rhythm down the overview. The
    // page used `space-y-8` (32 px) between top-level blocks while the vitals
    // wrap used `space-y-6` (24 px), so the overview read as two tiers. Unify
    // to `space-y-6` — it matches the vitals wrap and tightens the overview in
    // line with the "Insights gives away too much space" direction.
    <div className="space-y-6">
      <HeroStrip
        briefing={briefingPayload}
        updatedAt={heroStripUpdatedAt}
        userName={heroGreetingName}
        onAskCoach={
          coachLaunch
            ? (prefill?: string) => coachLaunch.askCoach(prefill ?? null)
            : undefined
        }
        onPickPrompt={
          coachLaunch
            ? (prompt) => coachLaunch.askCoach(prompt)
            : undefined
        }
        healthScore={analytics?.healthScore ?? undefined}
      />

      <WellnessScores
        read={dashboardDerived.read}
        isLoading={dashboardDerived.isLoading}
        isError={dashboardDerived.isError}
        refetch={dashboardDerived.refetch}
      />

      {flags.briefing && (
        <DailyBriefing
          briefing={briefingPayload}
          updatedAt={heroStripUpdatedAt}
          loading={advisor.isLoading}
          onRegenerate={advisor.regenerate}
          regenerating={advisor.isRegenerating}
        />
      )}

      <VitalsDashboard batch={dashboardDerived} />

      <TrendsRow
        briefing={briefingPayload}
        annotations={advisor.payload?.trendAnnotations ?? null}
        loading={advisor.isLoading || advisor.isRegenerating}
      />

      {flags.briefing && <PeriodNarrativeCard enabled={isAuthenticated} />}

      <CoincidentDeviationCard enabled={isAuthenticated} />

      <RhythmEventsCard enabled={isAuthenticated} />
    </div>
  );
}
