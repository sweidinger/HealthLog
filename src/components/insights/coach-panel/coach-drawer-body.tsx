"use client";

import { ChevronLeft, MessagesSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.20 phase B4 — pure presentational body for `<CoachDrawer>`.
 *
 * The drawer's outer Radix `<Sheet>` does not surface in SSR (its
 * portal is client-only), so the unit suite couldn't pin the
 * mobile-only rail-tray triggers via the `<CoachDrawer>` itself.
 * Lifting the body grid + chevron triggers + composer slot up here
 * gives the test a node-renderable surface; the `<CoachDrawer>`
 * itself stays the integrating shell that owns state + the trays.
 *
 * The component is stateless: the parent owns the tray state and
 * passes the open-toggles + slot content.
 *
 * v1.16.1 — two structural changes:
 *  - The sources rail lost its inline xl+ column. "What I draw on" is
 *    now hidden by default on every viewport and slides in as the
 *    right-edge tray when the user taps the toggle — the rail is a
 *    look-up surface, not something worth a permanent 280 px gutter.
 *  - The history affordance forked by surface: the drawer's
 *    "Conversations" button hands off to the full-page Coach route
 *    (the in-panel left tray kept breaking inside the sheet), while
 *    the page renders the conversation list inline as a left column
 *    on lg+ via the `historyRail` slot (tray below lg).
 */
export interface CoachDrawerBodyProps {
  thread: React.ReactNode;
  composer: React.ReactNode;
  /**
   * Inline conversation list (page surface only). When set, it renders
   * as a left column on lg+ and the history button collapses to the
   * sub-lg tray trigger. The drawer omits it.
   */
  historyRail?: React.ReactNode;
  onHistoryClick: () => void;
  onOpenSourcesTray: () => void;
}

export function CoachDrawerBody({
  thread,
  composer,
  historyRail,
  onHistoryClick,
  onOpenSourcesTray,
}: CoachDrawerBodyProps) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="coach-drawer-body"
      // v1.18.1 (W-COACH-UI C1/C3) — the inline history rail was a
      // tight 260 px gutter; widen it to 300 px (lg) / 340 px (xl) so
      // the conversation list breathes and the centre thread keeps the
      // remaining width. Without a rail the body is a single column.
      className={
        historyRail
          ? "grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr] xl:grid-cols-[340px_1fr]"
          : "grid min-h-0 flex-1 grid-cols-1"
      }
    >
      {/* Inline history column — page surface, lg+ only. */}
      {historyRail && (
        <aside
          data-slot="coach-drawer-history"
          className="border-border/70 hidden h-full min-h-0 border-r lg:flex lg:flex-col"
        >
          {/* v1.18.1 (W-COACH-UI C4) — the rail heading and the centre
              column's rail-tray strip share one fixed `h-14` header band
              with identical `border-b`, so the two dividers land on the
              same horizontal line across the columns (the asymmetry the
              maintainer flagged: a `p-3` text heading vs a `py-2` button
              strip put the lines at different heights). */}
          <h2 className="border-border/70 text-muted-foreground flex h-14 shrink-0 items-center border-b px-4 text-xs font-medium tracking-wide uppercase">
            {t("insights.coach.historyTitle")}
          </h2>
          <div className="min-h-0 flex-1 overflow-y-auto">{historyRail}</div>
        </aside>
      )}

      {/* Centre — message thread. */}
      <main
        data-slot="coach-drawer-thread"
        className="flex h-full min-h-0 flex-col"
      >
        {/* v1.4.27 R3d MB2 — rail-tray triggers lifted out of the
            absolute overlay into a sub-header strip so the buttons
            sit at a 44 px tap target and never overlay the first
            message bubble.
            v1.18.1 (W-COACH-UI C4) — fixed `h-14` so the strip's
            bottom border aligns with the history rail heading divider
            in the adjacent column (one continuous line, no restless
            two-height split). */}
        <div
          data-slot="coach-drawer-rail-tray-strip"
          className="border-border/70 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3"
        >
          <Button
            type="button"
            variant="ghost"
            onClick={onHistoryClick}
            data-slot="coach-drawer-history-tray-trigger"
            aria-label={t("insights.coach.historyTitle")}
            // With an inline history column (page surface, lg+) the
            // button is redundant above lg and hides there.
            className={
              historyRail
                ? "min-h-11 gap-1.5 text-xs lg:hidden"
                : "min-h-11 gap-1.5 text-xs"
            }
          >
            <MessagesSquare className="size-4" aria-hidden="true" />
            {t("insights.coach.historyTitle")}
          </Button>
          {/* Sources toggle — the rail is hidden by default on every
              viewport and opens as the right-edge tray. */}
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenSourcesTray}
            data-slot="coach-drawer-sources-tray-trigger"
            aria-label={t("insights.coach.sourcesTitle")}
            className="text-muted-foreground hover:text-foreground ml-auto min-h-11 gap-1.5 text-xs"
          >
            {t("insights.coach.sourcesTitle")}
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1">{thread}</div>
        {/* Composer pinned to the bottom. */}
        <div
          data-slot="coach-drawer-composer"
          className="border-border/70 flex flex-col gap-2 border-t p-3 sm:p-4"
        >
          {composer}
        </div>
      </main>
    </div>
  );
}
