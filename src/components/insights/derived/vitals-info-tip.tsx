"use client";

import { useState } from "react";
import { Info } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { ProvenanceStandard } from "./provenance-explainer";

/**
 * v1.29.2 QoL — the vitals-dashboard tile's (i) info affordance.
 *
 * v1.29.1 dropped the always-on "your personal normal range is the
 * median…" method caption from every `VITALS_BASELINE` tile because it
 * repeated verbatim across up to six tiles and read as clutter at the top
 * of the vitals surface — and, on the narrower tiles, squeezed the heading
 * itself (the VO₂max/cardio-fitness clip). Rather than reintroduce the
 * caption at full length, the SAME method/caveat/standard content moves
 * behind a small (i) trigger: a click-opened `Popover` (not a hover
 * tooltip — the vitals grid sees most of its use on touch), so the context
 * is one tap away instead of permanently occupying header space.
 *
 * This is a DELIBERATE, narrowly-scoped exception to the v1.22 "no
 * icon-only disclosure" direction (`ProvenanceExplainer`'s own docstring):
 * that decision targeted the always-visible-caption pattern on OTHER
 * surfaces (coincident-deviation, the score-anatomy pages), which stay
 * unchanged. The vitals grid is dense enough, and the caption repetitive
 * enough, that the same content is better one tap away here.
 */
export interface VitalsInfoTipProps {
  /** Plain-language method (+ optional caveat) description — text children only. */
  method: React.ReactNode;
  /** Optional cited standard, rendered as a plain external link. */
  standard?: ProvenanceStandard;
  className?: string;
}

export function VitalsInfoTip({
  method,
  standard,
  className,
}: VitalsInfoTipProps) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="vitals-info-trigger"
          aria-label={t("insights.derived.vitals.infoLabel")}
          aria-expanded={open}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
            "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
            "-mx-2 -my-3",
            "transition-colors focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
        >
          <Info className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="vitals-info-body"
        align="end"
        sideOffset={6}
        className="max-w-xs space-y-1.5"
      >
        <p className="text-muted-foreground text-xs leading-snug">{method}</p>
        {standard ? (
          <a
            href={standard.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary block text-xs leading-snug hover:underline"
          >
            {standard.name}
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
