"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ListOrdered } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CoachLaunchButton } from "@/components/insights/coach-launch-button";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W4 — common visual frame for each metric sub-page.
 *
 * Each sub-page renders:
 *   - a calm header (title + optional status badge),
 *   - the canonical chart for the metric (passed in as `chart` so the
 *     page can wire the right `chartKey`, target zones, value bands, …),
 *   - secondary slot for related cards (correlation cards, per-medication
 *     lists, …).
 *
 * The shell handles focus restoration on route change — a screen-reader
 * user landing here from a tab click hears the page heading
 * automatically because we mount an `id="insights-subpage-title"`
 * h1 with `tabIndex={-1}` and focus it on mount. Sighted users get a
 * `scrollTo({ top: 0 })` so deep-scroll position from the previous
 * sub-page doesn't leak in.
 */

export interface SubPageShellProps {
  title: string;
  /** Optional accent badge (status, dataset coverage, …). */
  badge?: ReactNode;
  /**
   * Optional short paragraph beneath the title, mirroring the Apple-Health
   * convention of a one-line scaffold on every metric page. The mother
   * page does not pass it; sub-pages use it to anchor the surface.
   */
  description?: string;
  /**
   * v1.8.0 — when set, the metric's static "What is X?" definition
   * renders as a muted caption directly beneath the heading. The value
   * is the metric key feeding `insights.subPage.explainer.<metric>Body`.
   * Omitted on the mother page; every routed metric sub-page passes its
   * key.
   *
   * v1.8.6 — the round `?` popover affordance next to the heading is
   * gone (it read as restless next to the title). The inline definition
   * caption stays — it is the single always-visible source of the
   * one- to two-sentence definition, no tap required.
   */
  explainerMetric?: string;
  /**
   * v1.4.27 MB7 / CF-35 — opt-in programmatic focus on mount.
   *
   * The legacy default-on `focus()` call moved screen-reader focus to
   * the heading but on mobile it also fought the soft-keyboard: a
   * sub-page navigation that landed while a form was open dismissed
   * the keyboard mid-typing. Default is now `false`; sub-pages that
   * actually want the screen-reader landing (today: none; the routed
   * sub-pages do not auto-focus anything) opt in explicitly.
   *
   * The `scrollTo({ top: 0 })` still fires unconditionally because
   * the deep-scroll reset between routed sub-pages is a sighted-user
   * affordance, not an a11y one.
   */
  focusOnMount?: boolean;
  /**
   * v1.8.5 W4b — numbers-first stat strip rendered directly beneath the
   * header, above the chart. Sub-pages pass `<MetricStatStrip metric=… />`
   * so every metric (including the thin HealthKit pages) leads with
   * min / max / median / mean. Omitted on the empty-state branch.
   */
  statStrip?: ReactNode;
  /**
   * v1.8.5 W4b — measurement-diversity nudge.
   *
   * v1.8.6 — relocated from an inline block under the stat strip to a
   * `Lightbulb` glyph beside the heading (a hover / focus Tooltip carries
   * the hint copy). The node is `<MeasurementDiversityNudge>`, which is
   * self-gating: it renders the glyph only when readings cluster on one
   * weekday / time, and nothing when the spread is healthy.
   */
  diversityNudge?: ReactNode;
  /**
   * v1.8.6 — opt-in Coach launch in the page header.
   *
   * When true, the shell mounts an icon-only `<CoachLaunchButton>` at
   * the top-right of the header, vertically aligned with the heading, so
   * "Coach fragen" reads as a header action rather than a foot-of-page
   * button. Every routed category page passes it; the mother page and
   * empty-state branches omit it. The button self-gates on the Coach
   * feature flag + per-user opt-out, so a disabled-Coach tenant shows
   * nothing.
   */
  coachLaunch?: boolean;
  /**
   * v1.8.5 W4b — a "show all readings" entry rendered at the foot of the
   * page, after the chart + cards. Sub-pages pass the metric's
   * `MeasurementType`; the shell renders a button that links to the
   * dedicated `/insights/values/<type>` subpage.
   */
  showAllValuesType?: string;
  children: ReactNode;
}

export function SubPageShell({
  title,
  badge,
  description,
  explainerMetric,
  focusOnMount = false,
  statStrip,
  diversityNudge,
  coachLaunch = false,
  showAllValuesType,
  children,
}: SubPageShellProps) {
  const { t } = useTranslations();
  // a11y: focus the heading on mount so a tab-strip navigation actually
  // moves screen-reader focus into the sub-page body. v1.4.27 MB7 /
  // CF-35 made the focus call opt-in via `focusOnMount` — the
  // default-on version stole focus from soft-keyboards on mobile.
  //
  // v1.4.33 IW9 — the scroll-to-top affordance moved into the shared
  // `useScrollResetOnRoute()` hook so the mother page + sub-page can't
  // both fire (which produced a visible double-snap when the chart
  // skeleton inflated between the two RAF callbacks). The hook itself
  // still defers to `requestAnimationFrame` so the scroll lands after
  // first paint, same behaviour the legacy in-line effect provided.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useScrollResetOnRoute();
  useEffect(() => {
    if (!focusOnMount || typeof window === "undefined") return;
    const handle = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [focusOnMount]);

  return (
    <div data-slot="insights-subpage" className="space-y-4 md:space-y-5">
      <header className="space-y-1.5">
        {/* v1.8.6 — the heading row pins the Coach icon top-right while the
            title / nudge / badge wrap together on the left.

            Design M2 fix: the Coach icon is a `shrink-0` sibling of the
            left group (not an `ml-auto` member of a single flex-wrap row),
            so a long or wrapped title can never isolate it or crowd it on a
            375 px screen — it stays cleanly top-right and the title text
            reflows in the space that remains.

            Design M1 fix: the row reserves a constant `min-h-10` so the
            baseline holds whether or not the self-gating diversity-nudge
            glyph (a 44 px-tall touch target) is present — category pages
            with and without a nudge now align. `items-start` keeps the
            Coach icon at the top of the row when the title wraps to two
            lines. */}
        <div className="flex min-h-10 items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1
              ref={headingRef}
              id="insights-subpage-title"
              tabIndex={-1}
              className={cn(
                "text-xl font-semibold sm:text-2xl",
                // a11y: sighted-keyboard users (e.g. "Skip to content")
                // need a visible focus indicator on the programmatic
                // `headingRef.focus()` call below. Match the focus ring
                // vocabulary used on insights pills + Coach affordances.
                "rounded-sm focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              )}
            >
              {title}
            </h1>
            {/* v1.8.6 — the diversity nudge rides the heading as a
                `Lightbulb` glyph (the node self-gates to nothing when the
                spread is healthy), replacing the old inline block. */}
            {diversityNudge}
            {badge ? (
              <Badge variant="outline" className="border text-xs">
                {badge}
              </Badge>
            ) : null}
          </div>
          {/* v1.8.6 — Coach launch sits top-right at heading height as an
              icon, pinned by the row's `justify-between` so it aligns with
              the title regardless of badge / glyph presence or a wrapped
              title. The button self-gates on the Coach flag + per-user
              opt-out. */}
          {coachLaunch ? (
            <CoachLaunchButton variant="icon" className="shrink-0" />
          ) : null}
        </div>
        {explainerMetric ? (
          // v1.8.4 — surface the metric's static definition inline,
          // directly beneath the heading.
          //
          // v1.8.5 W4a — render the explainer body as the *single* caption
          // under the heading. Pre-v1.8.5 both this paragraph and the
          // `description` below it stacked, so every metric page opened
          // with two near-duplicative muted captions before any data — the
          // root of the "airy / static under the heading" feel. The
          // explainer body is the definition, so it wins; the description
          // only renders when no explainer is set (the mother page and any
          // future explainer-less sub-page).
          //
          // v1.8.6 — this caption is now the only surface for the
          // definition; the round `?` popover that used to read the same
          // string was removed.
          <p
            data-slot="metric-explainer-inline"
            className="text-muted-foreground text-sm leading-relaxed"
          >
            {t(`insights.subPage.explainer.${explainerMetric}Body`)}
          </p>
        ) : null}
        {description && !explainerMetric ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </header>
      {/* v1.8.5 W4b — numbers-first stat strip sits between the header
          and the chart so the page leads with data, mirroring the Apple
          Health / Withings detail layout. Self-gating (renders nothing
          without data), so the spacing rhythm holds on the empty-state
          and brand-new-metric paths.
          v1.8.6 — the diversity nudge moved up to the heading row. */}
      {statStrip}
      {children}
      {/* v1.8.5 W4b — "show all readings" entry at the foot, linking to
          the dedicated per-metric values subpage.
          v1.8.6 — normalised to the `h-10` secondary-button height so it
          reads as a consistent control now that the foot-of-page Coach
          button (which set the old visual baseline) has moved to the
          header. */}
      {showAllValuesType ? (
        <Button
          asChild
          variant="outline"
          data-slot="metric-show-all-values"
          className="h-10 w-full sm:w-auto"
        >
          <Link href={`/insights/values/${showAllValuesType}`}>
            <ListOrdered className="mr-1.5 size-4" aria-hidden="true" />
            {t("insights.subPage.showAllValues")}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
