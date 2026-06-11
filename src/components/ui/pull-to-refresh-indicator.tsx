"use client";

import { ArrowDown, Loader2 } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { PullToRefreshState } from "@/hooks/use-pull-to-refresh";

/**
 * v1.16.4 — quiet pull-to-refresh affordance for the PWA list pages.
 *
 * A single small disc that descends from under the app bar as the user
 * pulls: an arrow while the gesture is short of the threshold, flipping
 * to a spinner once armed / refreshing. Fixed overlay — the page content
 * never shifts, so the gesture costs no layout. Renders nothing at rest;
 * the disc's opacity tracks the pull so a barely-started drag stays
 * barely visible. Touch-only by construction (the hook ignores mouse).
 */
export function PullToRefreshIndicator({
  pullDistance,
  refreshing,
  armed,
  threshold,
}: PullToRefreshState) {
  const { t } = useTranslations();

  if (pullDistance <= 0 && !refreshing) return null;

  // Progress drives both the descent and the fade-in; while refreshing the
  // disc parks at its full-descent resting point.
  const progress = refreshing ? 1 : Math.min(pullDistance / threshold, 1);
  const offset = refreshing ? threshold * 0.75 : pullDistance * 0.75;

  return (
    <div
      data-slot="pull-to-refresh-indicator"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center"
      style={{
        transform: `translateY(${offset}px)`,
        opacity: 0.35 + progress * 0.65,
        transition: refreshing ? "transform 150ms ease-out" : undefined,
      }}
    >
      <span
        className={cn(
          "bg-card text-muted-foreground flex size-8 items-center justify-center rounded-full border shadow-sm",
          (armed || refreshing) && "text-primary border-primary/40",
        )}
      >
        {refreshing ? (
          <Loader2
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <ArrowDown
            className="size-4 transition-transform duration-150"
            style={{ transform: armed ? "rotate(180deg)" : undefined }}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="sr-only">
        {refreshing ? t("common.pullToRefresh") : null}
      </span>
    </div>
  );
}
