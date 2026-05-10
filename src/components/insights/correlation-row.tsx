"use client";

import { useTranslations } from "@/lib/i18n/context";
import type { CorrelationResult } from "@/lib/insights/correlations";
import { CorrelationCard } from "./correlation-card";

/**
 * v1.4.20 phase B3 — Correlation row.
 *
 * Renders the pre-defined hypothesis cards in a 2-up grid on `>=md` and
 * a single column on `<md`. A single correlation-disclaimer footer sits
 * below the row — the disclaimer applies to every card so we don't
 * repeat it per-card.
 *
 * v1.4.22 A4 — empty-state cards are dropped instead of rendered. Any
 * hypothesis whose `status !== "ok"` is filtered out so the layout
 * collapses cleanly: 2 ok cards → 50/50, 1 ok card → 100 %, 0 ok cards
 * → the row hides itself entirely (no header, no disclaimer). Up to
 * v1.4.21 the `<CorrelationCard>` painted an EmptyState for below-
 * threshold results, which left half-rows of greyed-out placeholders
 * on a sparse account.
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

  // Drop insufficient-data tiles up-front. The grid below picks 1-col vs
  // 2-col automatically so 1 ok card spans 100 % width on its own row.
  const okResults = [
    results.bpCompliance,
    results.moodPulse,
    results.weightWeekday,
  ].filter((r) => r.status === "ok");

  if (okResults.length === 0) return null;

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
      <div
        className={
          okResults.length === 1
            ? "grid grid-cols-1 gap-4"
            : "grid grid-cols-1 gap-4 md:grid-cols-2"
        }
      >
        {okResults.map((result) => (
          <CorrelationCard key={result.kind} result={result} />
        ))}
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
