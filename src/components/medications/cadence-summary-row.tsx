"use client";

/**
 * v1.5.5 D-3 §9.3 — Cadence summary row.
 *
 * Renders the medication's cadence as a plain-language line (e.g.
 * "Alle 12 h nach letzter Einnahme", "Alle 2 Wochen, mittwochs",
 * "Monatlich am 15.") with an optional course-window sub-line, and an
 * optional edit pencil whose `onEdit` the caller wires (suppressed via
 * `hideEdit` on the read-only detail surface).
 * For one-shot medications the line collapses to
 * `Einmalig am DD.MM.` and the edit affordance is suppressed (the
 * header pencil owns the wizard route per D-3 §6 one-shot variant).
 *
 * The DOM order is `<h2> → <p> → edit`. The button comes last so a
 * screen-reader tab walk announces the title and the line before the
 * affordance (C-E4-3).
 */

import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import {
  hydrateWizardPayload,
  summariseCadence,
  type MedicationPayload,
} from "@/components/medications/wizard/wizard-payload";
import { useTranslations } from "@/lib/i18n/context";

export interface CadenceSummaryRowProps {
  medication: MedicationPayload;
  /** Hides the edit pencil — the one-shot variant relies on the header. */
  hideEdit?: boolean;
  onEdit: () => void;
}

export function CadenceSummaryRow({
  medication,
  hideEdit = false,
  onEdit,
}: CadenceSummaryRowProps) {
  const { t } = useTranslations();
  const payload = hydrateWizardPayload(medication);
  const line = summariseCadence(payload, t);

  return (
    <MedicationDetailSection
      titleId="medication-detail-cadence-heading"
      title={t("medications.detail.cadence.title")}
      dataSlot="medication-detail-cadence-section"
      headerExtras={
        hideEdit ? null : (
          <Button
            variant="outline"
            size="sm"
            onClick={onEdit}
            className="min-h-11 sm:min-h-9"
            data-slot="cadence-summary-edit"
          >
            <Pencil aria-hidden="true" className="h-4 w-4" />
            <span>{t("common.edit")}</span>
          </Button>
        )
      }
    >
      <p className="text-sm" data-slot="cadence-summary-line">
        {line}
      </p>
    </MedicationDetailSection>
  );
}
