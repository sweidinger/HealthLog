"use client";

/**
 * v1.5.5 D-3 §9.5 — Intake-history preview.
 *
 * Section chrome via `<MedicationDetailSection>`. Header CTA carries
 * the only CSV-import trigger in the app (the v1.5.4 per-card kebab
 * went away). The body re-uses `<IntakeHistoryListV2>` so the v1.5.4
 * table + sort + pagination stay byte-identical; the preview adds a
 * footer link to the full `/medications/[id]/history` route.
 *
 * Phase-2 add-ons (multi-select bulk-delete + row kebab Bearbeiten /
 * Löschen) ride on top of the wrapped list. The bulk-delete uses the
 * v1.5.5 `POST /api/medications/[id]/intake/bulk-delete` endpoint and
 * fires `medicationDependentKeys` so the inline compliance tile +
 * rollup-tier dashboard chart converge in one tick.
 */

import Link from "next/link";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IntakeHistoryListV2 } from "@/components/medications/intake-history-list-v2";
import { IntakeImportDialog } from "@/components/medications/intake-import-dialog";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { useTranslations } from "@/lib/i18n/context";

export interface IntakeHistoryPreviewProps {
  medicationId: string;
  importOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
}

export function IntakeHistoryPreview({
  medicationId,
  importOpen,
  onImportOpenChange,
}: IntakeHistoryPreviewProps) {
  const { t } = useTranslations();

  return (
    <>
      <MedicationDetailSection
        titleId="medication-detail-intake-history-heading"
        title={t("medications.detail.intake.title")}
        dataSlot="medication-detail-intake-history-section"
        headerExtras={
          <Button
            variant="outline"
            size="sm"
            onClick={() => onImportOpenChange(true)}
            className="min-h-11 sm:min-h-9"
            data-slot="intake-history-import"
          >
            <Upload aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.intake.importButton")}
          </Button>
        }
      >
        <div className="space-y-3" data-slot="intake-history-preview-body">
          <IntakeHistoryListV2 medicationId={medicationId} pageSize={14} />
          <p className="text-right text-xs">
            <Link
              href={`/medications/${medicationId}/history`}
              className="text-primary inline-flex min-h-11 items-center underline-offset-4 hover:underline sm:min-h-9"
              data-slot="intake-history-full-link"
            >
              {t("medications.detail.intake.viewAllLink")}
            </Link>
          </p>
        </div>
      </MedicationDetailSection>

      <IntakeImportDialog
        medicationId={importOpen ? medicationId : null}
        onClose={() => onImportOpenChange(false)}
      />
    </>
  );
}
