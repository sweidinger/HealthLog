"use client";

import { cn } from "@/lib/utils";

/**
 * Small two-plus-segment text toggle for medication-detail surfaces. Mirrors
 * the icon-only `MedicationViewToggle` chrome (bordered pill group, filled
 * active segment, ghost inactive) but carries text labels. `aria-pressed`
 * announces the state per segment; the group is named for screen readers.
 * Segments keep the 40-px mobile tap floor, shrinking to the 32-px control
 * height on desktop.
 */
export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedToggleProps<T extends string> {
  value: T;
  options: SegmentedToggleOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  dataSlot?: string;
}

export function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  dataSlot,
}: SegmentedToggleProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="border-border bg-background/30 inline-flex shrink-0 items-center rounded-md border p-0.5"
      {...(dataSlot ? { "data-slot": dataSlot } : {})}
    >
      {options.map(({ value: optionValue, label }) => {
        const active = value === optionValue;
        return (
          <button
            key={optionValue}
            type="button"
            onClick={() => {
              if (!active) onChange(optionValue);
            }}
            aria-pressed={active}
            data-slot={`${dataSlot ?? "segment"}-${optionValue}`}
            className={cn(
              "focus-visible:ring-ring inline-flex min-h-10 items-center justify-center rounded-[5px] px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none sm:min-h-8",
              active
                ? "bg-secondary text-secondary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
