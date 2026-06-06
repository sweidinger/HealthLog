/**
 * Fixed non-medical disclaimer for every fertility / prediction surface.
 *
 * Mirrors the GLP-1 drug-level-estimate disclaimer pattern
 * (`DrugLevelChart`): a styled, always-attached note rendered as plain
 * React text children (no markdown), so it cannot be dismissed or styled
 * away and carries no XSS surface.
 *
 * The copy is deliberate and load-bearing: predictions are descriptive
 * estimates from the user's own logged data — never a contraceptive
 * method, never medical advice, and never a "safe to have unprotected
 * sex" signal. Drop this under any calendar, wheel, fertile-window, or
 * predicted-period surface. The copy lives in `messages/<locale>.json`
 * under `cycle.disclaimer` and is translated for all six locales.
 */
"use client";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export interface CyclePredictionDisclaimerProps {
  /** Optional extra classes for layout (margins, width) at the call site. */
  className?: string;
}

export function CyclePredictionDisclaimer({
  className,
}: CyclePredictionDisclaimerProps) {
  const { t } = useTranslations();
  return (
    <p
      className={cn(
        "text-foreground/80 border-border bg-muted/40 rounded-md border-l-2 px-3 py-2 text-xs font-medium",
        className,
      )}
      data-slot="cycle-prediction-disclaimer"
    >
      {t("cycle.disclaimer")}
    </p>
  );
}
