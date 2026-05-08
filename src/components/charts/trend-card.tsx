"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

interface SecondaryMetric {
  /** Sub-value latest reading (e.g. diastolic when latest is systolic). */
  latest: number | null;
  avg7: number | null;
  avg30: number | null;
}

interface TrendCardProps {
  label: string;
  latest: number | null;
  unit: string;
  avg7: number | null;
  avg30: number | null;
  avg7ColorClass?: string;
  avg30ColorClass?: string;
  avg7Hint?: React.ReactNode;
  avg30Hint?: React.ReactNode;
  slope30: TrendSlope | null;
  icon: React.ComponentType<{ className?: string }>;
  /** Optional second value rendered next to the primary as `X / Y` (used for
   *  paired metrics like blood-pressure systolic/diastolic so a single tile
   *  shows both numbers). */
  secondary?: SecondaryMetric;
}

export function TrendCard({
  label,
  latest,
  unit,
  avg7,
  avg30,
  avg7ColorClass,
  avg30ColorClass,
  avg7Hint,
  avg30Hint,
  slope30,
  icon: Icon,
  secondary,
}: TrendCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const TrendIcon =
    slope30?.direction === "up"
      ? ArrowUp
      : slope30?.direction === "down"
        ? ArrowDown
        : slope30
          ? ArrowRight
          : Minus;

  // P4: Direction-as-good-or-bad is metric-specific (v1.5+ scope) —
  // keep the arrow flat at muted-foreground for both up/down/flat.
  const trendColor = "text-muted-foreground";

  const formatValue = (value: number) => fmt.number(value, 1);

  const renderPair = (
    primary: number | null,
    secondaryValue: number | null | undefined,
  ): string => {
    if (primary === null) return "—";
    if (secondary && secondaryValue !== null && secondaryValue !== undefined) {
      return `${formatValue(primary)}/${formatValue(secondaryValue)}`;
    }
    return formatValue(primary);
  };

  return (
    <div className="bg-card border-border flex h-full w-full flex-col rounded-xl border p-4 md:p-6">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </span>
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-bold tracking-tight tabular-nums">
          {latest !== null
            ? renderPair(latest, secondary?.latest)
            : "—"}
        </span>
        <span className="text-muted-foreground text-sm tabular-nums">
          {unit}
        </span>
        {slope30 && <TrendIcon className={`h-4 w-4 ${trendColor}`} />}
      </div>
      <TooltipProvider>
        <div className="text-muted-foreground mt-auto flex gap-3 pt-1 text-xs">
          <span>
            {t("charts.avg7dShort")}:{" "}
            {avg7Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn("font-medium tabular-nums", avg7ColorClass)}
                  >
                    {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg7Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={cn("font-medium tabular-nums", avg7ColorClass)}
              >
                {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
              </span>
            )}
          </span>
          <span>
            {t("charts.avg30dShort")}:{" "}
            {avg30Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn("font-medium tabular-nums", avg30ColorClass)}
                  >
                    {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg30Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={cn("font-medium tabular-nums", avg30ColorClass)}
              >
                {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
              </span>
            )}
          </span>
        </div>
      </TooltipProvider>
    </div>
  );
}
