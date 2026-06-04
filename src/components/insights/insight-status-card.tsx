"use client";

import { useEffect, useRef, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { cn } from "@/lib/utils";
import { useFeatureFlags } from "@/hooks/use-feature-flags";

// ─── Types ────────────────────────────────────────────────

interface InsightStatusCardProps {
  title: string;
  icon: React.ReactNode;
  text: string | null;
  hasProvider: boolean;
  /**
   * Whether the rendered text came from the warm cache rather than a
   * fresh generation. Retained on the contract so every caller can keep
   * threading it, but the card no longer surfaces a "cached" badge — the
   * label devalued the assessment and the caching is an implementation
   * detail the user does not need to see.
   */
  cached: boolean;
  updatedAt: string | null;
  loading?: boolean;
  /**
   * v1.8.3 — the read-only status route enqueued an out-of-band generation
   * and the assessment isn't warm yet. Render the same skeleton geometry as
   * `loading` but with a "preparing" caption so the user understands the
   * card is being assembled, not stuck. The client polls until text lands.
   */
  preparing?: boolean;
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
        className="gap-2 py-4 md:gap-3 md:py-5"
      >
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="bg-muted h-3.5 w-full animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-11/12 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-9/12 animate-pulse rounded motion-reduce:animate-none" />
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
        className="gap-2 py-4 md:gap-3 md:py-5"
      >
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <div className="bg-muted h-5 w-5 animate-pulse rounded motion-reduce:animate-none" />
            <div className="bg-muted h-4 w-32 animate-pulse rounded motion-reduce:animate-none" />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="bg-muted h-3.5 w-full animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-11/12 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-3.5 w-9/12 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted/70 h-3 w-1/3 animate-pulse rounded motion-reduce:animate-none" />
          <span className="sr-only">{t("common.loading")}</span>
        </CardContent>
      </Card>
    );
  }

  if (!hasProvider) {
    return (
      <Card className="gap-2 py-4 opacity-60 md:gap-3 md:py-5">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            {t("insights.noProviderConfigured")}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!text) {
    return (
      <Card className="gap-2 py-4 md:gap-3 md:py-5">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
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
      className="animate-insight-in gap-2 py-4 md:gap-3 md:py-5"
    >
      <CardHeader className="pb-2">
        {/* v1.11.5 — the top-right "cached" label was removed: it surfaced
            an implementation detail and devalued the assessment. The card
            still consumes the warm cache; it just no longer announces it. */}
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
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
  const { t } = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const paragraphRef = useRef<HTMLParagraphElement | null>(null);

  // Measure the clamped paragraph against its scroll height. When the
  // text fits inside the three-line clamp `scrollHeight` equals
  // `clientHeight`; an overflow means the clamp is hiding content and the
  // toggle earns its place. We measure against the *clamped* element, so
  // the check is gated on `!expanded` — once expanded the paragraph is no
  // longer clamped and the comparison would always read "fits".
  useEffect(() => {
    if (expanded) return;
    const node = paragraphRef.current;
    if (!node) return;

    const measure = () => {
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // Re-measure whenever the source text changes (a fresh assessment) or
    // the user collapses the card again.
  }, [text, expanded]);

  return (
    <div className="space-y-1">
      <p
        ref={paragraphRef}
        className={cn(
          "text-muted-foreground text-sm leading-relaxed",
          !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {/* Only render the toggle on a genuine overflow. When the full text
          fits inside three lines there is nothing more to show, so no
          affordance is painted. */}
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          data-slot="assessment-show-more"
          className={cn(
            "text-foreground/80 hover:text-foreground inline-flex text-xs font-medium",
            "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
          )}
        >
          {expanded
            ? t("insights.assessmentShowLess")
            : t("insights.assessmentShowMore")}
        </button>
      )}
    </div>
  );
}

function LastUpdatedFooter({ updatedAt }: { updatedAt: string | null }) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  if (!updatedAt) return null;
  return (
    // v1.11.5 — right-aligned so the timestamp tucks to the trailing edge
    // of the card for a tidier read against the left-aligned prose above.
    <p className="text-muted-foreground text-right text-xs">
      {t("insights.lastUpdated")}: {fmt.dateTime(updatedAt)}
    </p>
  );
}
