"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useDisableCoach } from "@/hooks/use-disable-coach";
import { queryKeys } from "@/lib/query-keys";

import { useChartTooltipActive } from "./use-chart-tooltip-active";

/**
 * v1.16.1 — the layout FAB is no longer a permanent launcher. It now
 * renders ONLY while an unseen Coach-initiated nudge exists (the
 * proactive `COACH_NUDGE` dispatch, surfaced by
 * `/api/insights/coach/nudge-status`): a floating circle at the bottom
 * right that opens the full-page Coach chat. It disappears once the
 * nudge counts as read — the user sent a Coach message after the
 * nudge (server-derived), or opened the Coach on this device (local
 * seen stamp keyed by the nudge timestamp).
 *
 * The previous always-on mobile FAB drew attention to nothing; the
 * inline "Ask Coach" pill in each page's action row stays the everyday
 * entry point.
 *
 * v1.4.33 (F15) — the bubble keeps the chart-tooltip auto-hide so it
 * never overlays a Recharts tooltip on the lower right.
 */

const NUDGE_SEEN_STORAGE_KEY = "healthlog-coach-nudge-seen";

export interface CoachNudgeStatus {
  nudgedAt: string | null;
  unread: boolean;
}

/**
 * Pure unread derivation — server signal AND-ed with the local
 * seen-stamp. Exported so the unit test pins the contract without a
 * QueryClient round-trip.
 */
export function isNudgeUnread(
  status: CoachNudgeStatus | undefined,
  seenStamp: string | null,
): boolean {
  if (!status?.unread || status.nudgedAt === null) return false;
  return seenStamp !== status.nudgedAt;
}

export function LayoutCoachFab() {
  const { t } = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const launch = useCoachLaunch();
  const flags = useFeatureFlags();
  const disableCoach = useDisableCoach();
  const tooltipActive = useChartTooltipActive();

  // Local "seen on this device" stamp — the nudge timestamp the user
  // last dismissed by opening the chat. Lazy initialiser per the
  // `react-hooks/set-state-in-effect` rule.
  const [seenStamp, setSeenStamp] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(NUDGE_SEEN_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const coachAvailable = !!launch && flags.coach && !disableCoach;
  const onCoachPage = pathname?.startsWith("/insights/coach") ?? false;

  const { data: status } = useQuery({
    queryKey: queryKeys.coachNudgeStatus(),
    queryFn: async (): Promise<CoachNudgeStatus> => {
      const res = await fetch("/api/insights/coach/nudge-status");
      if (!res.ok) throw new Error("coach-nudge-status.failed");
      return (await res.json()).data as CoachNudgeStatus;
    },
    enabled: coachAvailable,
    staleTime: 5 * 60 * 1000,
  });

  const nudgedAt = status?.nudgedAt ?? null;
  const unread = isNudgeUnread(status, seenStamp);

  // Visiting the Coach page itself counts as reading the nudge on this
  // device — persist the stamp so the bubble stays gone after leaving.
  useEffect(() => {
    if (!onCoachPage || nudgedAt === null) return;
    try {
      window.localStorage.setItem(NUDGE_SEEN_STORAGE_KEY, nudgedAt);
    } catch {
      // Storage unavailable (private mode) — the server-side read
      // signal still clears the bubble once the user sends a message.
    }
  }, [onCoachPage, nudgedAt]);

  if (!coachAvailable) return null;
  if (onCoachPage || !unread) return null;

  const accessibleLabel = t("insights.coach.nudgeBubbleLabel");

  const handleOpen = () => {
    if (nudgedAt !== null) {
      setSeenStamp(nudgedAt);
      try {
        window.localStorage.setItem(NUDGE_SEEN_STORAGE_KEY, nudgedAt);
      } catch {
        // Best effort — see above.
      }
    }
    router.push("/insights/coach");
  };

  return (
    <Button
      type="button"
      size="icon"
      data-slot="coach-nudge-bubble"
      data-chart-tooltip-active={tooltipActive ? "true" : undefined}
      onClick={handleOpen}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      aria-hidden={tooltipActive ? true : undefined}
      tabIndex={tooltipActive ? -1 : undefined}
      className={cn(
        // Sit above the 64 px bottom-nav + the iPhone home-indicator
        // safe-area inset on mobile; plain bottom offset on desktop.
        "fixed right-4 z-40 size-12 rounded-full shadow-lg",
        "bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] lg:bottom-6",
        "from-dracula-purple to-dracula-pink bg-gradient-to-br text-white",
        "hover:from-dracula-purple/90 hover:to-dracula-pink/90",
        // Fade out while a Recharts tooltip is open (see header note).
        "transition-opacity duration-150 motion-reduce:transition-none",
        tooltipActive && "pointer-events-none opacity-0",
      )}
    >
      <Sparkles className="size-5" aria-hidden="true" />
    </Button>
  );
}
