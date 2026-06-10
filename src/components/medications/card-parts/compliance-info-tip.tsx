"use client";

import { useState } from "react";
import { HelpCircle } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * Small `?` affordance that explains what the adherence percentage
 * actually measures ("share of expected doses you logged — weekly
 * schedules count week by week"). Sits next to the number on the two
 * surfaces that render an adherence rate without context: the
 * dashboard compliance card header and the per-medication bars
 * (`medication-compliance-bars.tsx`).
 *
 * Pattern follows `health-score-delta-explainer.tsx` (icon-only
 * trigger, 44 px hit target collapsed back to the row's stride via
 * negative margins). A click-opened Popover is used on every viewport
 * — unlike a hover Tooltip it stays reachable on touch devices, where
 * the medication cards see most of their use.
 */
export function ComplianceInfoTip({ className }: { className?: string }) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="compliance-info-trigger"
          aria-label={t("medications.complianceInfoLabel")}
          aria-expanded={open}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50",
            "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full",
            "-mx-2 -my-3",
            "transition-colors focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
        >
          <HelpCircle className="h-3 w-3" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="compliance-info-body"
        align="start"
        sideOffset={6}
        className="max-w-xs"
      >
        <p className="text-muted-foreground text-xs leading-snug">
          {t("medications.complianceInfo")}
        </p>
      </PopoverContent>
    </Popover>
  );
}
