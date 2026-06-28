"use client";

import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.25 — the one place the app states what it is and is not.
 *
 * HealthLog's self-description standard is layered, not a wall of warnings:
 * a single intended-purpose statement plus calm, context-specific notes that
 * sit once on the surface they belong to. Every string is plain React text —
 * no markdown renderer, in line with the project's XSS posture (Coach,
 * briefing and insights all render as text children).
 *
 * The copy lives under the `selfDescription` i18n namespace so every locale
 * carries the same set; pick the note that fits the surface:
 *
 * - `intendedPurpose` — the canonical "what this is / is not, not a medical
 *   device" line. Reuse verbatim; do not paraphrase per surface.
 * - `coach` — the Coach standing line (works from your data, not a doctor).
 * - `emergency` — the red-flag interstitial note (contact emergency services).
 * - `dataPosture` — self-hosted, data stays on your instance, BYOK / local AI.
 *
 * The acknowledged onboarding disclaimer (`onboarding.disclaimer.*`) and the
 * legal medical-device boundary on the public privacy page remain the standing
 * floor; these notes are the gentle, in-context layer above it.
 */
export type DisclaimerVariant =
  "intendedPurpose" | "coach" | "emergency" | "dataPosture";

const VARIANT_KEY: Record<DisclaimerVariant, string> = {
  intendedPurpose: "selfDescription.intendedPurpose",
  coach: "selfDescription.coach",
  emergency: "selfDescription.emergency",
  dataPosture: "selfDescription.dataPosture",
};

export interface MedicalDisclaimerProps {
  variant: DisclaimerVariant;
  className?: string;
}

/**
 * A calm, muted, plain-text disclaimer line. Defaults to a small,
 * unobtrusive footnote treatment; pass `className` to tune spacing for the
 * surface. Keep it to one instance per surface — the standard is layered,
 * not repeated.
 */
export function MedicalDisclaimer({
  variant,
  className,
}: MedicalDisclaimerProps) {
  const { t } = useTranslations();
  return (
    <p
      data-slot="medical-disclaimer"
      data-variant={variant}
      className={cn("text-muted-foreground text-xs leading-relaxed", className)}
    >
      {t(VARIANT_KEY[variant])}
    </p>
  );
}
