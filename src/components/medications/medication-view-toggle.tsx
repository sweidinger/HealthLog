"use client";

import { LayoutGrid, Table as TableIcon } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { MedicationListView } from "@/lib/medication-list-layout";

/**
 * v1.16.10 — icon-only card/table view toggle for the /medications page
 * header. A small two-segment control: the active segment carries the
 * filled surface, the inactive one stays ghost. `aria-pressed` announces
 * the state per segment; the group is named for screen readers. Segments
 * keep the 44-px mobile tap floor (`size-11`), shrinking to the standard
 * 36-px control height on desktop like the neighbouring Add button.
 */
interface MedicationViewToggleProps {
  view: MedicationListView;
  onChange: (view: MedicationListView) => void;
}

export function MedicationViewToggle({
  view,
  onChange,
}: MedicationViewToggleProps) {
  const { t } = useTranslations();

  const segments = [
    {
      value: "cards" as const,
      label: t("medications.viewCards"),
      icon: LayoutGrid,
    },
    {
      value: "table" as const,
      label: t("medications.viewTable"),
      icon: TableIcon,
    },
  ];

  return (
    <div
      role="group"
      aria-label={t("medications.viewToggleLabel")}
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
            data-slot={`medications-view-${value}`}
            className={cn(
              "focus-visible:ring-ring inline-flex size-10 items-center justify-center rounded-[5px] transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none sm:size-8",
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
