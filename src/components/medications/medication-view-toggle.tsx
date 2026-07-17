"use client";

import { LayoutGrid, Table as TableIcon } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { MedicationListView } from "@/lib/medication-list-layout";

/**
 * v1.16.10 — icon-only card/table view toggle for the /medications page
 * header. Thin wrapper over the shared `ViewToggle` primitive; see its
 * docstring for the interaction grammar.
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

  return (
    <ViewToggle
      view={view}
      onChange={onChange}
      groupLabel={t("medications.viewToggleLabel")}
      dataSlotPrefix="medications-view"
      segments={[
        {
          value: "cards",
          label: t("medications.viewCards"),
          icon: LayoutGrid,
        },
        {
          value: "table",
          label: t("medications.viewTable"),
          icon: TableIcon,
        },
      ]}
    />
  );
}
