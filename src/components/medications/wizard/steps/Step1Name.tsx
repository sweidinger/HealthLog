"use client";

import type { WizardPayload } from "../wizard-payload";

export interface StepProps {
  payload: WizardPayload;
  applyPartial: (partial: Partial<WizardPayload>) => void;
}

export function Step1Name(_props: StepProps) {
  return null;
}
