"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";

import type { StepProps } from "./Step1Name";

/**
 * Dose unit choices, ordered so mg / ml / IE / µg lead and the
 * device-form units (Tablette, Hub, Sprühstoß, …) follow. Mirrors the
 * v1.5.3 list with the Marc-requested order tightening.
 */
const DOSE_UNIT_KEYS = [
  "mg",
  "ml",
  "iu",
  "mcg",
  "g",
  "tablets",
  "capsules",
  "drops",
  "puffs",
  "sprays",
  "pieces",
  "other",
] as const;

export function Step3Dose({ payload, applyPartial }: StepProps) {
  const { t } = useTranslations();
  return (
    <div className="grid grid-cols-2 gap-3" data-slot="wizard-step3">
      <div className="space-y-1.5">
        <Label htmlFor="wizard-dose-amount" className="text-sm">
          {t("medications.wizard.steps.step3.amountLabel")}
        </Label>
        <Input
          id="wizard-dose-amount"
          type="text"
          inputMode="decimal"
          value={payload.doseAmount}
          onChange={(e) => applyPartial({ doseAmount: e.target.value })}
          placeholder={t("medications.wizard.steps.step3.amountPlaceholder")}
          maxLength={20}
          autoComplete="off"
          enterKeyHint="next"
          className="h-11"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wizard-dose-unit" className="text-sm">
          {t("medications.wizard.steps.step3.unitLabel")}
        </Label>
        <Select
          value={payload.doseUnit}
          onValueChange={(v) => applyPartial({ doseUnit: v })}
        >
          <SelectTrigger id="wizard-dose-unit" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DOSE_UNIT_KEYS.map((u) => (
              <SelectItem key={u} value={u}>
                {t(`medications.wizard.steps.step3.unit.${u}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
