"use client";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  ANALYTICS_RANGES,
  type AnalyticsRange,
} from "@/lib/analytics/range-delta";

/**
 * v1.9.0 — `7d / 30d / 90d / 1y` segmented control for the Insights metric
 * pages. The interaction model Apple Health / Oura users already know (a
 * range selector across the top of a metric chart). Built as an accessible
 * `radiogroup` of pills over the existing zinc/shadcn primitives rather than
 * pulling a new Radix dependency — the project's tab strip uses the same
 * custom-pill approach. The selected range drives the period-over-period
 * delta caption and (where wired) the chart window.
 */
export function TimeRangePills({
  value,
  onChange,
  className,
}: {
  value: AnalyticsRange;
  onChange: (range: AnalyticsRange) => void;
  className?: string;
}) {
  const { t } = useTranslations();

  return (
    <div
      role="radiogroup"
      aria-label={t("insights.range.label")}
      data-slot="time-range-pills"
      className={cn(
        "bg-muted/50 inline-flex items-center gap-0.5 rounded-lg p-0.5",
        className,
      )}
    >
      {ANALYTICS_RANGES.map((range) => {
        const selected = range === value;
        return (
          <button
            key={range}
            type="button"
            role="radio"
            aria-checked={selected}
            data-range={range}
            data-selected={selected}
            onClick={() => onChange(range)}
            className={cn(
              "focus-visible:ring-ring rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`insights.range.option.${range}`)}
          </button>
        );
      })}
    </div>
  );
}
