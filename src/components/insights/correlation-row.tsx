"use client";

import { useTranslations } from "@/lib/i18n/context";
import type { CorrelationResult } from "@/lib/insights/correlations";
import { CorrelationCard } from "./correlation-card";

/**
 * v1.4.20 phase B3 — Correlation row.
 *
 * Renders the three pre-defined hypothesis cards in a 2-up grid on
 * `>=md` and a single column on `<md`. A single correlation-disclaimer
 * footer sits below the row — the disclaimer applies to every card so
 * we don't repeat it per-card.
 *
 * The `<CorrelationCard>` itself owns the empty-state for below-
 * threshold results, so this row never has to filter — it always
 * mounts all three cards regardless of `status`.
 */

interface CorrelationRowProps {
  results: {
    bpCompliance: CorrelationResult;
    moodPulse: CorrelationResult;
    weightWeekday: CorrelationResult;
  };
}

export function CorrelationRow({ results }: CorrelationRowProps) {
  const { t } = useTranslations();

  return (
    <section
      data-slot="correlation-row"
      aria-label={t("insights.correlationRow.title")}
      className="space-y-3"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          {t("insights.correlationRow.title")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("insights.correlationRow.subtitle")}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CorrelationCard result={results.bpCompliance} />
        <CorrelationCard result={results.moodPulse} />
        <CorrelationCard result={results.weightWeekday} />
      </div>
      <p
        data-slot="correlation-row-disclaimer"
        className="text-muted-foreground text-xs italic"
      >
        {t("insights.correlationRow.disclaimer")}
      </p>
    </section>
  );
}
