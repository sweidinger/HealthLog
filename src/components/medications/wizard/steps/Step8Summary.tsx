"use client";

import type {
  MedicationPayload,
  WizardPayload,
} from "../wizard-payload";

export interface Step8SummaryProps {
  payload: WizardPayload;
  applyPartial: (partial: Partial<WizardPayload>) => void;
  mode: "create" | "edit";
  initial?: MedicationPayload;
  submitError: string | null;
}

export function Step8Summary(_props: Step8SummaryProps) {
  return null;
}
