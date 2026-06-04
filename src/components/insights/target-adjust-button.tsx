"use client";

import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";
import { useTargetAdjust } from "@/lib/insights/target-adjust-context";

/**
 * Header gear that opens the per-metric target editor.
 *
 * The "Adjust target range" affordance used to sit inside the target
 * reference card; it now lives in the Insights category-page header
 * (`<SubPageShell>`), to the left of the Coach launch icon, so the card
 * stays a read surface. The button is a thin wrapper around
 * `useTargetAdjust()`:
 *
 *   - renders nothing when no provider is mounted or no editable target
 *     has registered for the page (e.g. a metric without a numeric
 *     target band, where the card paints nothing), so the header never
 *     shows a dead control;
 *   - opens the primary registered target's `<TargetEditSheet>` on click.
 *
 * Sized to match `<CoachLaunchButton variant="icon">` so the gear + the
 * Coach sparkle read as a consistent icon cluster top-right of the
 * heading.
 */
export function TargetAdjustButton({ className }: { className?: string }) {
  const { t } = useTranslations();
  const adjust = useTargetAdjust();

  // No provider, or no editable target registered for this page.
  if (!adjust || !adjust.canAdjust) return null;

  // Reuse the action's existing copy ("Adjust target range" /
  // "Zielbereich anpassen") — the gear performs exactly what the old
  // in-card link did, so the same string is the right accessible label.
  const label = t("insights.subPage.target.adjustLink");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot="target-adjust-trigger"
      aria-label={label}
      title={label}
      onClick={() => adjust.requestAdjust()}
      className={cn(
        // The `icon` size is 40 px; bump to the 44 px WCAG 2.5.5 floor on
        // mobile and settle back to the 40 px that matches the sibling
        // Coach icon from `sm` up, so the cluster reads as one on desktop.
        "text-muted-foreground hover:text-foreground size-11 sm:size-10",
        className,
      )}
    >
      <Settings2 className="size-4" aria-hidden="true" />
    </Button>
  );
}
