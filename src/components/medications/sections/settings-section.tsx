"use client";

/**
 * v1.5.5 D-3 §9.7 — Settings section.
 *
 * Hosts the four sub-rows the v1.5.4 form retirement displaced:
 * Externe Integration (API tokens), CSV-Import stub (one-line pointer
 * to the intake-history header CTA, no button), Phasen (button →
 * `<PhaseConfigSheet>`, mounts only on GLP-1 + course window set), and
 * Grace minutes (primary-schedule-scoped).
 *
 * Per H-3-UX: the CSV-Import row is a one-line stub. The actual
 * import affordance lives next to the table it changes (the
 * intake-history header), so the page mounts the dialog exactly once
 * via lifted state.
 *
 * Per H-4-UX: the Grace row's label flags it as primary-schedule
 * scoped so the user knows a multi-schedule medication does not get a
 * fan-out from this control.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface SettingsSectionProps {
  medicationId: string;
  medicationName: string;
  treatmentClass?: string;
  startsOn?: string | null;
  endsOn?: string | null;
  reminderGraceMinutes?: number | null;
}

export function SettingsSection({
  medicationId,
  medicationName,
  treatmentClass,
  startsOn,
  endsOn,
  reminderGraceMinutes,
}: SettingsSectionProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);
  const [graceValue, setGraceValue] = useState(
    typeof reminderGraceMinutes === "number" ? reminderGraceMinutes : 30,
  );
  const [graceBusy, setGraceBusy] = useState(false);

  const isGlp1 = treatmentClass === "GLP1";
  const hasCourseWindow = Boolean(startsOn) && Boolean(endsOn);
  const showPhases = isGlp1 && hasCourseWindow;

  async function saveGrace() {
    if (graceBusy) return;
    setGraceBusy(true);
    try {
      // Primary-schedule scope: the PUT body's schedules array is
      // absent so the server preserves existing schedules; the route
      // accepts top-level `reminderGraceMinutes` as a primary-schedule
      // override on the v1.5.4 flat-form bridge.
      const res = await fetch(`/api/medications/${medicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminderGraceMinutes: graceValue }),
      });
      if (!res.ok) {
        toast.error(t("medications.detail.settings.grace.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.settings.grace.saved"));
    } catch {
      toast.error(t("medications.detail.settings.grace.failed"));
    } finally {
      setGraceBusy(false);
    }
  }

  return (
    <MedicationDetailSection
      titleId="medication-detail-settings-heading"
      title={t("medications.detail.settings.title")}
      dataSlot="medication-detail-settings-section"
    >
      <div className="space-y-4" data-slot="medication-detail-settings-body">
        {/* Externe Integration — API tokens */}
        <ApiTokensRow
          medicationId={medicationId}
          medicationName={medicationName}
        />

        <Separator />

        {/* CSV-Import stub — H-3-UX */}
        <div
          className="space-y-1"
          data-slot="medication-detail-csv-import-row"
        >
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.settings.csvImport.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.settings.csvImport.stub")}
          </p>
        </div>

        {/* Phasen — GLP-1 + course-window gated */}
        {isGlp1 && (
          <>
            <Separator />
            <div
              className="space-y-2"
              data-slot="medication-detail-phase-management-row"
            >
              <div className="space-y-1">
                <p className="text-foreground text-sm font-medium">
                  {t("medications.phaseConfig")}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("medications.phaseConfigDescription")}
                </p>
              </div>
              {showPhases ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPhaseSheetOpen(true)}
                  className="min-h-11 sm:min-h-9"
                  data-slot="medication-detail-phase-management-button"
                >
                  {t("medications.detail.settings.phases.openButton")}
                </Button>
              ) : (
                <p
                  className="text-muted-foreground text-xs italic"
                  data-slot="medication-detail-phase-management-empty"
                >
                  {t("medications.detail.settings.phases.requiresCourseWindow")}
                </p>
              )}
            </div>
          </>
        )}

        <Separator />

        {/* Grace minutes — primary-schedule scoped */}
        <div
          className="space-y-2"
          data-slot="medication-detail-grace-row"
        >
          <Label
            htmlFor="medication-detail-grace-input"
            className="text-foreground text-sm font-medium"
          >
            {t("medications.detail.settings.grace.label")}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.settings.grace.primaryScheduleNote")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="medication-detail-grace-input"
              type="number"
              min={0}
              max={720}
              value={graceValue}
              onChange={(e) => setGraceValue(Number(e.target.value) || 0)}
              className="w-24"
            />
            <span className="text-muted-foreground text-xs">
              {t("medications.detail.settings.grace.unit")}
            </span>
            <Button
              size="sm"
              onClick={() => void saveGrace()}
              disabled={graceBusy}
              aria-busy={graceBusy || undefined}
              className="min-h-11 sm:min-h-9"
            >
              {t("common.save")}
            </Button>
          </div>
        </div>
      </div>

      {showPhases && (
        <PhaseConfigSheet
          medicationId={medicationId}
          open={phaseSheetOpen}
          onOpenChange={setPhaseSheetOpen}
        />
      )}
    </MedicationDetailSection>
  );
}
