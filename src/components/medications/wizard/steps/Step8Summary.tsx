"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";

import {
  type MedicationPayload,
  summariseCadence,
  type WizardPayload,
} from "../wizard-payload";

export interface Step8SummaryProps {
  payload: WizardPayload;
  applyPartial: (partial: Partial<WizardPayload>) => void;
  mode: "create" | "edit";
  initial?: MedicationPayload;
  submitError: string | null;
}

export function Step8Summary({
  payload,
  applyPartial,
  mode,
  initial,
  submitError,
}: Step8SummaryProps) {
  const { t } = useTranslations();
  const summary = summariseCadence(payload, t);

  // v1.5.4 ships single-schedule editing only. A medication that
  // already carries multiple schedules surfaces a note pointing at
  // the legacy detail form; the multi-schedule compose-mode lands in
  // v1.5.5 per the design hand-off (D-1 §10 deferred bullet 2).
  const isMultiSchedule =
    mode === "edit" && (initial?.schedules.length ?? 0) > 1;

  return (
    <div className="space-y-4" data-slot="wizard-step8">
      <div
        className="bg-muted/40 rounded-md border p-3 text-sm"
        data-slot="wizard-summary"
      >
        <p className="mb-1 font-medium">
          {t("medications.wizard.summary.title")}
        </p>
        <p>{summary}</p>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label
            htmlFor="wizard-reminders"
            className="text-sm font-medium"
          >
            {t("medications.wizard.steps.step8.remindersLabel")}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t("medications.wizard.steps.step8.remindersDescription")}
          </p>
        </div>
        <Switch
          id="wizard-reminders"
          checked={payload.notificationsEnabled}
          onCheckedChange={(checked) =>
            applyPartial({ notificationsEnabled: checked })
          }
          data-slot="wizard-reminders-toggle"
          aria-label={t("medications.wizard.steps.step8.remindersLabel")}
        />
      </div>

      {isMultiSchedule && (
        <p
          className="text-muted-foreground border-border/70 rounded-md border border-dashed p-3 text-xs"
          data-slot="wizard-multi-schedule-note"
        >
          {t("medications.wizard.steps.step8.multiScheduleNote")}
        </p>
      )}

      {submitError && (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-slot="wizard-submit-error"
        >
          {submitError}
        </p>
      )}
    </div>
  );
}
