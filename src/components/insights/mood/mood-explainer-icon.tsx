"use client";

import { Info } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * v1.12.4 (C3/C4) — compact explainer affordance for the mood surface.
 *
 * Replaces the low-density inline "how this was computed" text rows
 * (paired-day counts, the false-discovery footer, the observational
 * disclaimer) with a single ring/info icon. The detail moves into a
 * hover/focus tooltip so the surface stops spending a full-width row on a
 * footnote. The trigger is a real focusable `button` carrying an
 * `aria-label`, so the explanation is reachable by keyboard and screen
 * readers — not hover-only. Self-contained `TooltipProvider` so callers
 * don't need an ambient one.
 */
export function MoodExplainerIcon({
  label,
  detail,
  className,
}: {
  /** Accessible name for the trigger (what the icon explains). */
  label: string;
  /** The explanation shown in the tooltip. */
  detail: string;
  className?: string;
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={label}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-current/40 transition-colors focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
        >
          <Info className="size-3" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent className="max-w-[16rem] text-xs leading-snug">
          {detail}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
