"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Minimize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CoachConversation } from "@/components/insights/coach-panel/coach-conversation";
import { ModuleTourTrigger } from "@/components/onboarding/module-tour-trigger";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";

/**
 * v1.12.0 (Coach v2 #6) — full-page Coach conversation.
 *
 * Renders the exact same `<CoachConversation>` surface the drawer uses
 * (history + streaming thread + composer + provenance + settings) at
 * full width and height. There is no forked chat logic — the page is a
 * thin chrome wrapper that supplies a "minimize back to drawer"
 * control where the drawer supplies "maximize" + "close".
 *
 * v1.18.0 — the route is a standalone top-level page (`/coach`), no longer
 * nested under `app/insights/layout.tsx`, so it renders in the standard
 * page chrome WITHOUT the Insights tab strip. It still sits inside the
 * authenticated `<AuthShell>` (which provides the `<CoachLaunchProvider>`
 * the minimize control reopens the drawer through), so the page inherits
 * the same Coach feature gating as every other Coach surface. When the
 * operator's master flag is off or the user opted out, the page redirects
 * back to `/insights` rather than painting a dead chat shell.
 */
export default function CoachPage() {
  const { t } = useTranslations();
  const router = useRouter();
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();

  const coachUnavailable = !flags.coach || disableCoach;

  // Coach surface gating mirrors `<CoachLaunchButton>` / `<LayoutCoachFab>`:
  // operator master flag OR per-user opt-out hides the Coach entirely.
  // Send a direct navigator back to the Insights mother page so the
  // route is never a dead-end.
  useEffect(() => {
    if (coachUnavailable) {
      router.replace("/insights");
    }
  }, [coachUnavailable, router]);

  if (coachUnavailable) return null;

  const handleMinimize = () => {
    // Hand the conversation back to the drawer overlay: route to the
    // Insights mother page and reopen the drawer through the shared
    // launch context.
    router.push("/insights");
    launch?.askCoach(null);
  };

  return (
    <div
      data-slot="coach-page"
      data-tour-id="coach-hero"
      // v1.18.6 (CCH-01) — Marc: the Coach read "cut off" vs other pages
      // and wanted more width / a focused Claude-like surface. The page
      // sits inside `<AuthShell>`'s shared `mx-auto max-w-screen-xl px-4
      // pt-6 pb-20 md:px-6` content frame, which boxed the chat into the
      // same narrow column every dashboard card uses and left a tall dead
      // band below the card (the `pb-20` FAB gutter, pointless here since
      // the FAB hides on `/coach`). Break out of that frame: negative
      // margins cancel the container's horizontal + top/bottom padding so
      // the chat claims the full content width and the viewport height,
      // then a light inner padding keeps it off the window edge. The card
      // itself drops its rounded border on small screens (edge-to-edge,
      // app-like) and keeps the contained card look from `sm+`.
      //
      // v1.18.1 (W-COACH-UI C1/C3) — the card formerly capped at
      // `100dvh-13rem`, leaving wasted space below it; we now fill the
      // reclaimed height.
      className={
        // Cancel the AuthShell container's padding (`-mt-6` top,
        // `-mb-20` bottom, `-mx-4 md:-mx-6` sides) so the surface is
        // full-bleed, then re-pad lightly. The height is the full
        // viewport minus the top bar (`4rem`) and the small gutters.
        "-mx-4 -mt-6 -mb-20 flex h-[calc(100dvh-4rem)] min-h-[32rem] flex-col md:-mx-6 " +
        "px-2 pt-2 pb-3 sm:px-4 sm:pt-4 sm:pb-4"
      }
    >
      <div
        data-slot="coach-page-card"
        className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-none border-y shadow-sm sm:rounded-2xl sm:border"
      >
      <CoachConversation
        surface="page"
        autoFocusComposer
        renderTitle={(title) => (
          <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        )}
        leadingHeaderActions={
          <>
            <ModuleTourTrigger stopId="coach" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleMinimize}
              data-slot="coach-page-minimize"
              aria-label={t("insights.coach.minimizeAriaLabel")}
              title={t("insights.coach.minimizeAriaLabel")}
              className="text-muted-foreground hover:text-foreground size-11 shrink-0"
            >
              <Minimize2 className="size-4" aria-hidden="true" />
            </Button>
          </>
        }
        />
      </div>
    </div>
  );
}
