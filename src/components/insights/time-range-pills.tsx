"use client";

import { useRef, type KeyboardEvent } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  ANALYTICS_RANGES,
  type AnalyticsRange,
} from "@/lib/analytics/range-shared";

/**
 * v1.9.0 — `7d / 30d / 90d / 1y` segmented control for the Insights metric
 * pages. The interaction model Apple Health / Oura users already know (a
 * range selector across the top of a metric chart). Built as an accessible
 * `radiogroup` of pills over the existing zinc/shadcn primitives rather than
 * pulling a new Radix dependency — the project's tab strip uses the same
 * custom-pill approach. The selected range drives the period-over-period
 * delta caption and (where wired) the chart window.
 *
 * Follows the WAI-ARIA APG radiogroup pattern: the group is a single tab
 * stop (only the checked radio is `tabIndex={0}`, the rest `-1`) and the
 * arrow keys / Home / End move selection with a roving focus, so a keyboard
 * user does not tab through all four and the arrow keys are not dead.
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
  const radiosRef = useRef<Array<HTMLButtonElement | null>>([]);

  const selectAt = (index: number) => {
    const next = ANALYTICS_RANGES[index];
    onChange(next);
    // Roving focus follows selection so the newly checked radio is focused.
    radiosRef.current[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = ANALYTICS_RANGES.indexOf(value);
    const last = ANALYTICS_RANGES.length - 1;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        selectAt(current >= last ? 0 : current + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        selectAt(current <= 0 ? last : current - 1);
        break;
      case "Home":
        event.preventDefault();
        selectAt(0);
        break;
      case "End":
        event.preventDefault();
        selectAt(last);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={t("insights.range.label")}
      data-slot="time-range-pills"
      onKeyDown={onKeyDown}
      className={cn(
        "bg-muted/50 inline-flex items-center gap-0.5 rounded-lg p-0.5",
        className,
      )}
    >
      {ANALYTICS_RANGES.map((range, index) => {
        const selected = range === value;
        return (
          <button
            key={range}
            ref={(el) => {
              radiosRef.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
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
