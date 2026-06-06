"use client";

import { cn } from "@/lib/utils";

/**
 * v1.15.0 — the fixed non-medical disclaimer for every prediction / fertility
 * surface. Mirrors the GLP-1 drug-level-estimate disclaimer pattern
 * (`DrugLevelChart`): a muted, border-left note that stays attached wherever
 * an estimate renders. The copy is descriptive-not-a-contraceptive,
 * not-medical-advice — never a green/safe claim. The text comes from the
 * server (`cycle.prediction.disclaimer`, surfaced on the prediction DTO) so
 * the web + iOS + the engine speak the same words.
 */
export function CycleDisclaimer({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <p
      data-slot="cycle-disclaimer"
      className={cn(
        "text-foreground/80 border-border bg-muted/40 rounded-md border-l-2 px-3 py-2 text-xs font-medium",
        className,
      )}
    >
      {text}
    </p>
  );
}
