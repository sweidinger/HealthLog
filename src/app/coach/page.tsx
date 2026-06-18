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
      // v1.18.1 (W-COACH-UI C1/C3) — the card was capped at
      // `100dvh-13rem`, leaving a band of wasted space below it on a
      // standalone route that no longer carries the Insights tab strip.
      // Claim the page height down to a comfortable bottom gutter so the
      // thread + rail fill the viewport, and lift the card with a soft
      // shadow so it reads as one contained surface rather than a thin
      // outline.
      className="bg-card flex h-[calc(100dvh-8rem)] min-h-[32rem] flex-col overflow-hidden rounded-2xl border shadow-sm"
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
  );
}
