"use client";

/**
 * v1.5.5 D-3 §9.1 — medication-detail page header band.
 *
 * Renders the drug name as the H1, dose as a muted sub-line, and a
 * status row carrying a Dracula-token dot + always-visible label
 * (Aktiv / Pausiert / Beendet) and an edit pencil that opens the
 * wizard with the `"name"` intent (Step 1 landing). The DOM order is
 * `name → dose → status → edit` so the screen reader announces the
 * drug first and the affordance last (C-E4-3).
 *
 * The status pill text is always rendered; the dot carries
 * `aria-hidden="true"` and reads from Dracula tokens via
 * `bg-[hsl(var(--success))]` / `bg-[hsl(var(--warning))]` /
 * `bg-muted-foreground`. The "since DD.MM." drift the earlier draft
 * mixed into the header is dropped — lifecycle dates live on the
 * destructive zone, not on the header (E-2 M-1).
 */

import { ChevronDown, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";

export interface MedicationDetailHeaderProps {
  name: string;
  dose: string;
  active: boolean;
  endsOn?: string | null;
  /**
   * v1.5.6 G-1 §4 — "Plan bearbeiten" opens the wizard (mode="edit",
   * Step 1). Fired from the Bearbeiten dropdown's first item.
   */
  onEditPlan: () => void;
  /**
   * v1.5.6 G-1 §4 — "Erweiterte Einstellungen" opens the
   * `<AdvancedSettingsSheet>`. Fired from the dropdown's second item.
   */
  onOpenAdvanced: () => void;
}

type Status = "active" | "paused" | "ended";

function resolveStatus(active: boolean, endsOn?: string | null): Status {
  // `endsOn` set + in the past = the medication is archived. The
  // server flips `active=false` in that case but a paused medication
  // also reads false; distinguish here so the pill carries the right
  // label.
  if (endsOn) {
    const end = new Date(endsOn);
    if (!Number.isNaN(end.getTime()) && end.getTime() <= Date.now()) {
      return "ended";
    }
  }
  return active ? "active" : "paused";
}

export function MedicationDetailHeader({
  name,
  dose,
  active,
  endsOn,
  onEditPlan,
  onOpenAdvanced,
}: MedicationDetailHeaderProps) {
  const { t } = useTranslations();
  const status = resolveStatus(active, endsOn);

  const statusLabel =
    status === "active"
      ? t("medications.detail.status.active")
      : status === "paused"
        ? t("medications.detail.status.paused")
        : t("medications.detail.status.ended");

  const dotClass =
    status === "active"
      ? "bg-[hsl(var(--success))]"
      : status === "paused"
        ? "bg-[hsl(var(--warning))]"
        : "bg-muted-foreground";

  return (
    <div
      className="flex items-start justify-between gap-3"
      data-slot="medication-detail-header"
    >
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">{name}</h1>
        <p className="text-muted-foreground text-sm">{dose}</p>
        <div
          className="text-muted-foreground flex items-center gap-2 text-xs"
          data-slot="medication-detail-status-row"
        >
          <Badge variant="secondary" className="gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${dotClass}`}
            />
            {statusLabel}
          </Badge>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-slot="medication-detail-edit-button"
          >
            <Pencil aria-hidden="true" className="h-4 w-4" />
            <span>{t("common.edit")}</span>
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={onEditPlan}
            data-slot="medication-detail-edit-plan"
          >
            {t("medications.detail.edit.planOption")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onOpenAdvanced}
            data-slot="medication-detail-edit-advanced"
          >
            {t("medications.detail.edit.advancedOption")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
