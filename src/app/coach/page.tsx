"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { CoachConversation } from "@/components/insights/coach-panel/coach-conversation";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";

/**
 * v1.12.0 (Coach v2 #6) — full-page Coach conversation.
 *
 * Renders the exact same `<CoachConversation>` surface the drawer uses
 * (history + streaming thread + composer + provenance + settings) at
 * full width and height. There is no forked chat logic — the page is a
 * thin chrome wrapper around the shared surface.
 *
 * v1.18.0 — the route is a standalone top-level page (`/coach`), no longer
 * nested under `app/insights/layout.tsx`, so it renders in the standard
 * page chrome WITHOUT the Insights tab strip. It still sits inside the
 * authenticated `<AuthShell>` (which provides the `<CoachLaunchProvider>`
 * the bottom-right FAB drawer reopens through), so the page inherits the
 * same Coach feature gating as every other Coach surface. When the
 * operator's master flag is off or the user opted out, the page redirects
 * back to `/insights` rather than painting a dead chat shell.
 *
 * v1.18.10 (W4) — the page is now a single full-bleed conversation
 * surface: the inner panel chrome (the bordered/rounded card) is gone so
 * the chat is no longer a window-inside-a-window, and the top "back to the
 * drawer" minimize control is removed (pointless on the dedicated page —
 * the separate bottom-right FAB drawer is the compact surface). The chat
 * claims the full content width and the viewport height below the top bar.
 */
export default function CoachPage() {
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

  // Reopening the bottom-right FAB drawer is no longer wired to a page
  // control, but keep the launch context referenced so the lint rule does
  // not flag the unused hook — the drawer the page hands back to lives in
  // the shared `<AuthShell>`.
  void launch;

  if (coachUnavailable) return null;

  return (
    <div
      data-slot="coach-page"
      data-tour-id="coach-hero"
      // v1.18.10 (W4) — full-bleed conversation surface. Cancel the
      // AuthShell container's padding (`-mt-6` top, `-mb-20` bottom,
      // `-mx-4 md:-mx-6` sides) so the chat is edge-to-edge and claims the
      // full viewport height minus the top bar (`4rem`). No inner card:
      // `<CoachConversation>` paints directly onto the page so it reads as
      // one continuous conversation, not a window inside a window. The
      // separate bottom-right FAB/overlay drawer stays the compact surface.
      //
      // v1.18.10 (W10) — height is mobile-aware. The fixed `<BottomNav>`
      // (64px + iOS home-indicator inset) is mobile-only; the desktop
      // full-bleed layout has no bottom nav. On mobile the page must subtract
      // the TopBar (`4rem`) AND the BottomNav band (`4rem` +
      // `env(safe-area-inset-bottom)`) so the docked composer / Stop control
      // always clears the nav instead of sitting under it. On `md+` the nav
      // is hidden, so the page reclaims the full height below the TopBar.
      className="bg-background -mx-4 -mt-6 -mb-20 flex h-[calc(100dvh-8rem-env(safe-area-inset-bottom,0px))] min-h-[32rem] flex-col overflow-hidden md:-mx-6 md:h-[calc(100dvh-4rem)]"
    >
      <CoachConversation
        surface="page"
        autoFocusComposer
        renderTitle={(title) => (
          <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        )}
      />
    </div>
  );
}
