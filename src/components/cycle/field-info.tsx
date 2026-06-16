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
 * v1.18.1 — the cycle log-sheet field-explainer affordance.
 *
 * A small "?" / info icon that puts a factual, descriptive-only one-liner
 * (what a clinical field means — BBT, cervical mucus, an LH surge) right at
 * the point of capture, so a first-time user never has to leave the sheet to
 * understand a term. Mirrors the mood surface's `MoodExplainerIcon` precedent
 * (self-contained `TooltipProvider`, a real focusable `<button>` trigger with
 * an `aria-label`, keyboard- and SR-reachable via Radix) but bumps the hit
 * area to ≥44 px for touch, since the cycle sheet is a thumb-first surface.
 *
 * Copy stays descriptive-only — never diagnosis or medical advice — matching
 * the phase-education honesty gate.
 */
export function FieldInfo({
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
          data-slot="cycle-field-info"
          className={cn(
            // size-6 icon inside an 11-unit (44 px) hit box so touch targets
            // clear the WCAG 2.5.8 / Apple HIG minimum without enlarging the
            // visible glyph.
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring -m-2.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full p-2.5 transition-colors focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
        >
          <Info className="size-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent className="max-w-[16rem] text-xs leading-snug">
          {detail}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
