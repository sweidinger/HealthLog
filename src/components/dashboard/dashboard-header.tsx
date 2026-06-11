"use client";

/**
 * Dashboard page header: title + greeting line, the customize shortcut,
 * and the quick-add dropdown that opens the quick-entry sheets.
 *
 * Extracted from the dashboard page; the page owns the open-state the
 * dropdown items set via `onQuickEntry`.
 */
import Link from "next/link";
import { Activity, Pill, Plus, Settings2, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import type { QuickEntryDialog } from "@/components/dashboard/quick-entry-sheets";

export function DashboardHeader({
  welcomeText,
  onQuickEntry,
}: {
  welcomeText: string;
  onQuickEntry: (dialog: NonNullable<QuickEntryDialog>) => void;
}) {
  const { t } = useTranslations();
  return (
    /* v1.4.37 W4a item 7 — centre-align the Hinzufügen button
       against the 2-line title block on mobile (< sm). The
       `welcomeText` line wraps under the title at < 380 px so the
       button used to float at the top of the row without a
       baseline anchor; `items-center sm:items-start` keeps the
       mobile vertical centre while preserving the original
       top-aligned posture on sm+ (where the title is one line). */
    <div className="flex items-center justify-between gap-4 sm:items-start">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("dashboard.title")}
        </h1>
        {/* v1.16.8 — `min-h-5` reserves the greeting's line box from the
            SSR pass on: the text personalises (name appended) on the
            first client re-render after hydration, and the reserved
            line keeps the header from collapsing/growing around that
            swap. */}
        <p className="text-muted-foreground mt-1 min-h-5 text-sm">
          {welcomeText}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {/* Customize shortcut to the dashboard-customization settings
            (the tile/layout editor at /settings/dashboard). Sits to
            the left of the add button as a monochrome ghost icon, with
            a `min-h-11 min-w-11` mobile floor so it meets the 44 px
            touch-target contract the add button also honours, shrinking
            back to the 40 px icon footprint on sm+. */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          data-testid="dashboard-customize-shortcut"
        >
          <Link
            href="/settings/dashboard"
            aria-label={t("dashboard.customizeDashboard")}
            title={t("dashboard.customizeDashboard")}
          >
            <Settings2 className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* v1.4.33 maintainer-item-7 — restore proportional sizing
                across viewports. The v1.4.27 fix pinned a `size="sm"
                min-h-11` combo to hit WCAG 2.5.5's 44 px touch-target
                contract on mobile, but `size="sm"` is h-8 (32 px) and
                the `min-h-11` override stretched the cap vertically
                while keeping the small horizontal padding — the
                button read as klobig on Pixel 5. Switch to
                `size="default"` (h-10 = 40 px) on mobile with a
                responsive `min-h-11 sm:min-h-9` so the button is
                44 px tall under finger pressure and shrinks back to
                the desktop-friendly 36 px on `sm:` upwards. The icon
                + label keep the same visual contract. */}
            <Button
              size="default"
              className="min-h-11 sm:min-h-9"
              data-tour-id="dashboard-quick-add"
            >
              <Plus className="h-4 w-4" />
              {t("common.add")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
            {/* Menu items must each carry a self-contained verb-phrase
                ("Log measurement", "Log mood") — the trigger above already
                says "Add", and the icon is `aria-hidden`, so the visible
                text is the only thing distinguishing the rows. v1.4.15
                phase-A3 fix #1 hardened this with a unit guard at
                `src/app/__tests__/quick-add-labels.test.ts` — both labels
                must differ from each other AND from `common.add`. */}
            <DropdownMenuItem onClick={() => onQuickEntry("measurement")}>
              <Activity className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("dashboard.quickAddMeasurement")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onQuickEntry("mood")}>
              <Waves className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("dashboard.quickAddMood")}
            </DropdownMenuItem>
            {/* v1.4.37 W7b — third quick-add row: medication intake.
                Same Sheet-on-mobile / Dialog-on-desktop primitive as
                the other two; the menu label is a self-contained
                verb-phrase so it doesn't collide with the trigger or
                the sibling rows (cf. quick-add-labels.test.ts). */}
            <DropdownMenuItem onClick={() => onQuickEntry("medicationIntake")}>
              <Pill className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("dashboard.quickAddMedicationIntake")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
