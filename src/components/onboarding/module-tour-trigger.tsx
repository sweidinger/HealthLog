"use client";

/**
 * v1.18.6 — per-module "Diese Tour zeigen" re-entry.
 *
 * A small ghost button each module page drops into its header action
 * cluster. It dispatches the `healthlog:module-tour` window event with
 * the page's stop id; the shell-level `<TourLauncher>` picks it up and
 * opens the spotlight narrowed to that single module card on the
 * current page (no cross-page navigation, no completion flip).
 *
 * Anchors to the page's `data-tour="<…>-hero"` element via the launcher
 * → overlay path. The button itself carries no anchor — it only fires
 * the event.
 */

import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import type { TourStopId } from "@/lib/onboarding/tour-state";

export function ModuleTourTrigger({ stopId }: { stopId: TourStopId }) {
  const { t } = useTranslations();

  function show() {
    if (typeof window === "undefined") return;
    try {
      window.dispatchEvent(
        new CustomEvent("healthlog:module-tour", { detail: { stopId } }),
      );
    } catch {
      /* ignore — sandboxed iframes etc. */
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={show}
      // 44px mobile tap floor, matching the rest of the module headers.
      className="text-muted-foreground hover:text-foreground min-h-11 sm:min-h-9"
      data-testid={`module-tour-trigger-${stopId}`}
    >
      <Compass className="h-4 w-4" />
      <span className="sr-only sm:not-sr-only">
        {t("onboarding.tour.moduleTrigger")}
      </span>
    </Button>
  );
}
