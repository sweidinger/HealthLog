"use client";

import { Info } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * A small, tap-reachable help affordance. Replaces the bare `title=`
 * attribute, which never surfaces on touch. The trigger is a real button
 * with an accessible name, so keyboard and screen-reader users reach the
 * same hint a pointer user gets on hover; tapping the button focuses it,
 * which opens the tooltip on touch devices.
 */
export function InfoHint({
  label,
  className,
}: {
  /** The hint text shown inside the tooltip. */
  label: string;
  className?: string;
}) {
  const { t } = useTranslations();
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-slot="info-hint"
            aria-label={t("common.moreInfo")}
            className={cn(
              // A 44px (WCAG 2.5.5) tap target whose visible footprint stays at
              // the 24px the icon needs: the 44px box is offset by an equal
              // negative margin (`p-2.5` + `-m-2.5`), so surrounding inline
              // layout is unchanged while the touchable area meets the floor.
              "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -m-2.5 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full p-2.5 transition-colors focus-visible:ring-2 focus-visible:outline-none",
              className,
            )}
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          data-slot="info-hint-body"
          align="start"
          className="max-w-xs leading-relaxed"
        >
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
