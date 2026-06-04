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
 * The component is stateless: the parent owns `historyTrayOpen` /
 * `sourcesTrayOpen` and passes the open-toggles + slot content. This
 * keeps the trigger logic + the desktop rail layout in one place
 * while delegating the actual side-sheet to the parent.
 *
 * v1.12.0 — the history rail is no longer an inline column on any
 * viewport; it lives behind the always-visible "Conversations" toggle
 * and opens as the left-edge tray. The body therefore no longer takes
 * a `historyRail` slot — the parent wires that rail straight into the
 * `<MobileRailTray>`.
 */
export interface CoachDrawerBodyProps {
  sourcesRail: React.ReactNode;
  thread: React.ReactNode;
  composer: React.ReactNode;
  /** Clinical-decisions disclaimer line, pinned above the composer. */
  disclaimer: React.ReactNode;
  onOpenHistoryTray: () => void;
  onOpenSourcesTray: () => void;
}

export function CoachDrawerBody({
  sourcesRail,
  thread,
  composer,
  disclaimer,
  onOpenHistoryTray,
  onOpenSourcesTray,
}: CoachDrawerBodyProps) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="coach-drawer-body"
      // v1.12.0 — the conversation history is no longer a permanent
      // left column. It used to mount inline on lg+ (a fixed 260px
      // gutter) which ate the chat width on laptops and read as a
      // takeover on the narrowed drawer cap. The rail now lives behind
      // the "Conversations" toggle on EVERY viewport (opens as the
      // left-edge tray), so the thread keeps the full width by default
      // and the user summons history on demand. The sources rail stays
      // inline at xl+ where there is room; below xl it stays on the
      // chevron tray.
      className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[1fr_280px]"
    >
      {/* Centre — message thread. */}
      <main
        data-slot="coach-drawer-thread"
        className="flex h-full min-h-0 flex-col"
      >
        {/* v1.4.27 R3d MB2 — rail-tray triggers lifted out of the
            absolute overlay into a sub-header strip so the chevrons
            sit at a 44 px tap target and never overlay the first
            message bubble.

            v1.12.0 — the strip is now ALWAYS rendered because the
            "Conversations" toggle is the only way to reach the history
            rail on every viewport (the rail is no longer an inline
            column). The history trigger stays visible at all
            breakpoints; the sources trigger keeps `xl:hidden` since the
            sources rail is inline at xl+. */}
        <div
          data-slot="coach-drawer-rail-tray-strip"
          className="border-border/70 flex items-center justify-between gap-2 border-b px-3 py-2"
        >
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenHistoryTray}
            data-slot="coach-drawer-history-tray-trigger"
            aria-label={t("insights.coach.historyTitle")}
            className="min-h-11 gap-1.5 text-xs"
          >
            <MessagesSquare className="size-4" aria-hidden="true" />
            {t("insights.coach.historyTitle")}
          </Button>
          {/* Sources tray trigger stays visible up to xl since the
              inline sources rail is xl+ only. */}
          <Button
            type="button"
            variant="ghost"
            onClick={onOpenSourcesTray}
            data-slot="coach-drawer-sources-tray-trigger"
            aria-label={t("insights.coach.sourcesTitle")}
            className="min-h-11 gap-1.5 text-xs xl:hidden"
          >
            {t("insights.coach.sourcesTitle")}
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1">{thread}</div>
        {/* Composer pinned to the bottom. v1.12.0 — the clinical-
            decisions disclaimer renders directly above the composer
            (the single, always-visible home; the thread-bottom and
            sources-rail copies were removed). */}
        <div
          data-slot="coach-drawer-composer"
          className="border-border/70 flex flex-col gap-2 border-t p-3 sm:p-4"
        >
          {disclaimer}
          {composer}
        </div>
      </main>

      {/* Sources rail — xl+ only. lg viewports surface it via the
          mobile chevron tray to keep the underlying /insights column
          readable behind the narrowed drawer cap. */}
      <aside
        data-slot="coach-drawer-sources"
        className="border-border/70 hidden h-full min-h-0 border-l xl:flex xl:flex-col"
      >
        {sourcesRail}
      </aside>
    </div>
  );
}
