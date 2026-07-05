"use client";

import Link from "next/link";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { formatUpdatedLabel } from "@/lib/i18n/relative-time";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { ProseBlocks } from "@/components/insights/prose-blocks";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { AskCoachIconButton } from "@/components/insights/ask-coach-action";
import type { CoachLaunchScope } from "@/lib/insights/coach-launch-context";

// ─── Types ────────────────────────────────────────────────

/**
 * v1.12.6 — route the icon + title row through the canonical
 * `<TileHeader>`. Callers still pass a pre-sized icon NODE (e.g.
 * `<HeartPulse className="h-5 w-5" />`) because the bespoke metric pages
 * own that prop; `<TileHeader>` drives its icon off a component, so wrap
 * the node in a thin component that renders it.
 *
 * v1.12.7 (M2) — `<TileHeader>` owns the canonical `h-5 w-5 text-foreground`
 * sizing and passes it through as `className` to its icon component. The
 * previous wrapper rendered the node verbatim and dropped that class, so a
 * caller passing an unsized (or mis-sized) node could drift off the contract.
 * The wrapper now forwards `<TileHeader>`'s className onto a sizing span that
 * normalizes the glyph — the `[&>svg]:size-5` rule pins any child SVG to the
 * canonical box regardless of what the caller passed. Callers that already
 * pass `<Icon className="h-5 w-5" />` stay visually identical.
 */
function nodeIcon(icon: React.ReactNode): React.ComponentType<{
  className?: string;
}> {
  return function StatusIcon({ className }: { className?: string }) {
    return (
      <span className={cn("inline-flex [&>svg]:size-5", className)}>
        {icon}
      </span>
    );
  };
}

interface InsightStatusCardProps {
  title: string;
  icon: React.ReactNode;
  text: string | null;
  hasProvider: boolean;
  updatedAt: string | null;
  loading?: boolean;
  /**
   * v1.8.3 — the read-only status route enqueued an out-of-band generation
   * and the assessment isn't warm yet. Render the same skeleton geometry as
   * `loading` but with a "preparing" caption so the user understands the
   * card is being assembled, not stuck. The client polls until text lands.
   */
  preparing?: boolean;
  /**
   * v1.21.0 (C4 H2) — opt-in "Ask the Coach about this assessment" hand-off.
   * When `coachQuestion` is set (the metric-aware caller supplies it), the
   * populated card renders a discreet Coach action seeded with that opener
   * and narrowed to `coachScope` when known. Callers that omit it keep the
   * card exactly as before — additive.
   */
  coachQuestion?: string;
  coachScope?: CoachLaunchScope;
  /**
   * Auto-send the seeded opener as the first turn (assessment hand-off)
   * instead of only seeding the composer. Defaults to false.
   */
  coachAutoSend?: boolean;
}

// ─── Main Component ───────────────────────────────────────

export function InsightStatusCard({
  title,
  icon,
  text,
  hasProvider,
  updatedAt,
  loading = false,
  preparing = false,
  coachQuestion,
  coachScope,
  coachAutoSend,
}: InsightStatusCardProps) {
  const { t } = useTranslations();
  const flags = useFeatureFlags();
  // v1.4.31 — operator can hide every per-metric status card
  // app-wide. The delta number stays; the LLM narration card is
  // suppressed in full so the layout collapses naturally.
  if (!flags.insightStatus) return null;

  // v1.8.3 — preparing: the read-only route enqueued a generation and the
  // client is polling. Render the loading skeleton geometry with a
  // preparing caption so the card reads as "assembling", not stuck. Only
  // shown when a provider is configured (the route returns the no-key
  // fallback otherwise).
  if (preparing && hasProvider && !text) {
    return (
      <Card
        aria-busy="true"
        aria-live="polite"
        data-testid="insight-status-card-preparing"
        className="gap-1.5 py-4 md:py-5"
      >
        <CardHeader className="pb-1">
          <TileHeader icon={nodeIcon(icon)} title={title} />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="bg-muted h-3.5 w-full rounded" />
          <Skeleton className="bg-muted h-3.5 w-11/12 rounded" />
          <Skeleton className="bg-muted h-3.5 w-9/12 rounded" />
          <p className="text-muted-foreground text-xs">
            {t("insights.assessmentPreparing")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    // v1.4.37 — structured skeleton over the centred spinner. When the
    // per-metric status route had to fall back to the 20 s provider
    // race the user used to stare at a single centred spinner with
    // "Lade…" copy, which gave no sense of progress and pinned the
    // card to a flat dot. The skeleton paints the actual rendered
    // geometry (icon dot, title bar, three text lines, footer) so the
    // loading state previews where the assessment will land. Heights
    // mirror `<CardTitle>` (`text-base` → 1 rem) and the prose
    // (`text-sm` → 0.875 rem) so the post-load swap reflows by less
    // than a row.
    return (
      <Card
        aria-busy="true"
        aria-live="polite"
        data-testid="insight-status-card-loading"
        // v1.13.1 — match the canonical `gap-1.5` + `pb-1` heading-to-body
        // rhythm the populated / preparing / empty states use, so the
        // heading and the first skeleton line sit on the same tight
        // baseline across every assessment-card state.
        className="gap-1.5 py-4 md:py-5"
      >
        <CardHeader className="pb-1">
          <div className="flex items-center gap-2">
            <Skeleton className="bg-muted h-5 w-5 rounded" />
            <Skeleton className="bg-muted h-4 w-32 rounded" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="bg-muted h-3.5 w-full rounded" />
          <Skeleton className="bg-muted h-3.5 w-11/12 rounded" />
          <Skeleton className="bg-muted h-3.5 w-9/12 rounded" />
          <Skeleton className="bg-muted/70 h-3 w-1/3 rounded" />
          <span className="sr-only">{t("common.loading")}</span>
        </CardContent>
      </Card>
    );
  }

  if (!hasProvider) {
    return (
      <Card className="gap-1.5 py-4 opacity-80 md:py-5">
        <CardHeader className="pb-1">
          <TileHeader icon={nodeIcon(icon)} title={title} />
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          <p className="text-muted-foreground text-sm">
            {t("insights.noProviderConfigured")}
          </p>
          <Link
            href="/settings/ai"
            data-slot="insight-status-no-provider-cta"
            className="text-primary text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("insights.noProviderAction")}
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (!text) {
    return (
      <Card className="gap-1.5 py-4 md:py-5">
        <CardHeader className="pb-1">
          <TileHeader icon={nodeIcon(icon)} title={title} />
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.noAnalysisYet")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    // v1.4.38 W-D P2-2 — `aria-live="polite"` so screen readers
    // announce the assessment when it swaps into the same slot the
    // structured skeleton occupied. The skeleton card already carries
    // `aria-busy="true" aria-live="polite"`; mirroring the live region
    // on the success card closes the load→loaded transition signal.
    <Card
      aria-live="polite"
      // v1.12.2 — stable hook for the spine guard test, which asserts the
      // assessment is the LAST content block on every bespoke metric page.
      data-slot="insight-assessment"
      // v1.8.5 W4a — the `Card` primitive ships `gap-4 md:gap-6` as the flex
      // gap between header and content, which floated the "Einschätzung"
      // heading ~16-24 px above its prose. Override to `gap-2 md:gap-3` (the
      // `CardHeader`'s own `pb-2` does not touch the flex gap) and trim the
      // shell padding to `py-4 md:py-5` so the assessment block reads tight
      // in the denser sub-page rhythm. The same override lands on every
      // status variant below so the gap is consistent across states.
      //
      // v1.8.6 — drop the purple left accent (`border-l-dracula-purple
      // border-l-2`). The coloured rule made the assessment card read as
      // restless against the calmer surrounding cards; the plain card
      // border carries enough separation on its own.
      //
      // v1.12.8 — tighten the header-to-prose gap. The card flex gap is
      // `gap-1.5` (was `gap-2 md:gap-3`) and the `CardHeader` trims its
      // bottom padding to `pb-1` (was `pb-2`), so the `<TileHeader>` sits
      // close to the prose and matches the header-to-body rhythm of the
      // sibling tiles. The loading skeleton keeps its own spacing.
      className="animate-insight-in gap-1.5 py-4 md:py-5"
    >
      <CardHeader className="pb-1">
        {/* v1.11.5 — the top-right "cached" label was removed: it surfaced
            an implementation detail and devalued the assessment. The card
            still consumes the warm cache; it just no longer announces it.
            v1.12.6 — the icon + title row is the canonical `<TileHeader>`.
            v1.25 — the Coach hand-off lives in the header's right slot as a
            single icon button (no text label, tooltip + accessible name),
            shared across every assessment card. Rendered only when the
            caller supplied an opener; the button self-gates on the Coach
            triple, so it never paints a dead control. */}
        <TileHeader
          icon={nodeIcon(icon)}
          title={title}
          right={
            coachQuestion ? (
              <AskCoachIconButton
                question={coachQuestion}
                scope={coachScope}
                autoSend={coachAutoSend}
              />
            ) : undefined
          }
        />
      </CardHeader>
      <CardContent className="space-y-2">
        {/* v1.4.27 — defence-in-depth strip. Cached status text from
            pre-v1.4.27 rows can still carry literal `metric:<TYPE>`
            tokens the model embedded on the assumption a chart would
            render inline. The sub-page never mounts the chart, so the
            token surfaces verbatim. The producer side now strips too;
            this consumer-side wrap keeps existing caches clean while
            they roll forward. */}
        <StatusBody text={stripChartTokens(text)} />
        <LastUpdatedFooter updatedAt={updatedAt} />
      </CardContent>
    </Card>
  );
}

/**
 * v1.4.27 MB7 / CF-39 — collapsible status copy. The assessment text
 * routinely lands at 3-5 paragraphs of dense narrative which dominates
 * the surface on phones. The default collapses to 3 lines via
 * `line-clamp-3`; a "Show more" toggle reveals the full body.
 *
 * v1.11.5 — the toggle now mounts only when the clamped prose actually
 * overflows three lines, measured against the live layout rather than a
 * character-count guess. The previous ~220-character heuristic painted a
 * "Show more" affordance on text that already fit (and could miss text
 * that wrapped past three lines on a narrow column), so a tap revealed
 * nothing. We compare the paragraph's `scrollHeight` against its
 * `clientHeight` while clamped; the toggle renders only on a true
 * overflow, and re-measures on resize / font load via `ResizeObserver`.
 */
function StatusBody({ text }: { text: string }) {
  // The assessment shows in full — the 3-line clamp + "show more" toggle
  // hid the prose behind an extra tap for no gain on a card whose whole
  // point is the text. Body prose reads in the regular foreground; muted
  // stays reserved for meta lines (timestamps, captions).
  return (
    <div className="text-foreground text-sm">
      <ProseBlocks text={text} />
    </div>
  );
}

function LastUpdatedFooter({ updatedAt }: { updatedAt: string | null }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  if (!updatedAt) return null;
  return (
    // v1.11.5 — right-aligned so the timestamp tucks to the trailing edge
    // of the card for a tidier read against the left-aligned prose above.
    //
    // v1.22 (W6) — the freshness caption is the calendar-bucketed
    // `formatUpdatedLabel` ("Updated today, 14:30" / "yesterday" / "on DD.MM."),
    // matching the briefing + per-metric cards. The day boundary follows the
    // user's profile timezone, not the browser's.
    <p className="text-muted-foreground text-right text-xs">
      {formatUpdatedLabel(
        updatedAt,
        t,
        fmt.dateShort,
        fmt.time,
        user?.timezone,
      )}
    </p>
  );
}
