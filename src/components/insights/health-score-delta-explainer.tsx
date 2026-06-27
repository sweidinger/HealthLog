"use client";

import { useId } from "react";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.28 R3c-Insights — explain the "vs last week" delta.
 *
 * v1.22 — the icon-only `?` glyph that gated the three-sentence read behind
 * a popover / bottom-sheet is removed; the maintainer wants the trailing
 * help affordance gone across the insights surface. The descriptive read
 * now renders inline as a muted caption beside the delta line, so it is
 * always visible rather than disclosure-only. The body keeps its id so the
 * parent's `aria-describedby` on the delta digit still threads to it.
 *
 * Operator suppression is preserved: when `healthScoreExplainer` is off the
 * caption does not render (the parent delta digit stays visible because the
 * parent paints it directly).
 */

interface HealthScoreDeltaExplainerProps {
  /** The delta value the parent paints on the line above. Retained for callers. */
  delta: number;
  /** Optional className for the caption so the parent can tune its spacing. */
  className?: string;
  /**
   * Optional id the parent owns and threads to the caption. The same id sits
   * on the parent's delta `<span>` as `aria-describedby` so screen readers
   * connect the digit to the read.
   */
  bodyId?: string;
}

export function HealthScoreDeltaExplainer({
  className,
  bodyId,
}: HealthScoreDeltaExplainerProps) {
  const { t } = useTranslations();
  const flags = useFeatureFlags();
  // Stable fallback id when the parent doesn't supply one. The hook sits
  // above the conditional return so the hook order stays stable.
  const generatedId = useId();
  const resolvedBodyId = bodyId ?? generatedId;

  // v1.4.31 — operator can hide the read; silent suppression per the
  // architecture brief.
  if (!flags.healthScoreExplainer) return null;

  return (
    <span
      id={resolvedBodyId}
      data-slot="health-score-delta-explainer-body"
      className={cn("text-muted-foreground text-xs leading-snug", className)}
    >
      {t("insights.healthScore.deltaExplainer.body")}
    </span>
  );
}
