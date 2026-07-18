"use client";

import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ViewToggleSegment<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
}

export interface ViewToggleProps<T extends string> {
  view: T;
  onChange: (view: T) => void;
  segments: ViewToggleSegment<T>[];
  /** Accessible name for the segmented-control group. */
  groupLabel: string;
  /** `data-slot` prefix per segment, rendered as `${dataSlotPrefix}-${value}`. */
  dataSlotPrefix: string;
}

/**
 * Shared icon-only segmented view toggle (e.g. cards vs table/list). A small
 * two-segment control: the active segment carries the filled surface, the
 * inactive one stays ghost. `aria-pressed` announces the state per segment;
 * the group is named for screen readers. Segments keep the 44-px mobile tap
 * floor (`size-11`), shrinking to the 36-px control height on desktop
 * (`sm:size-9`) like a neighbouring Add button — the same floor the intake
 * kebab and history-rail delete controls raised in this release window
 * (L3, `.planning/audits/2026-07-18-qa-ui.md`).
 *
 * Previously forked between the medications module
 * (`medications/medication-view-toggle.tsx`) and the Vorsorge/Illness/Labs
 * settings pages (`module-list/module-view-toggle.tsx`) — verbatim
 * copy-paste that only diverged in icons + i18n keys and had already
 * drifted. Both are now thin wrappers over this one primitive.
 */
export function ViewToggle<T extends string>({
  view,
  onChange,
  segments,
  groupLabel,
  dataSlotPrefix,
}: ViewToggleProps<T>) {
  return (
    <div
      role="group"
      aria-label={groupLabel}
      className="border-border bg-background/30 inline-flex shrink-0 items-center rounded-md border p-0.5"
    >
      {segments.map(({ value, label, icon: Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => {
              if (!active) onChange(value);
            }}
            aria-pressed={active}
            aria-label={label}
            title={label}
            data-slot={`${dataSlotPrefix}-${value}`}
            className={cn(
              "focus-visible:ring-ring inline-flex size-11 items-center justify-center rounded-[5px] transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none sm:size-9",
              active
                ? "bg-secondary text-secondary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
