"use client";

import { LayoutGrid, List as ListIcon } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { ModuleListView } from "@/lib/module-list-prefs";

/**
 * v1.18.6 (W8 / MOD-03) — icon-only card/list view toggle shared by the
 * Vorsorge / Illness / Labs settings pages. Mirrors the medication module's
 * `MedicationViewToggle` grammar (two ghost segments, the active one filled,
 * `aria-pressed` per segment) but switches between a card grid and a compact
 * list rather than cards-vs-table, so the label set is `moduleList.view*`.
 */
interface ModuleViewToggleProps {
  view: ModuleListView;
  onChange: (view: ModuleListView) => void;
}

export function ModuleViewToggle({ view, onChange }: ModuleViewToggleProps) {
  const { t } = useTranslations();

  const segments = [
    {
      value: "cards" as const,
      label: t("moduleList.viewCards"),
      icon: LayoutGrid,
    },
    {
      value: "list" as const,
      label: t("moduleList.viewList"),
      icon: ListIcon,
    },
  ];

  return (
    <div
      role="group"
      aria-label={t("moduleList.viewToggleLabel")}
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
            data-slot={`module-view-${value}`}
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
