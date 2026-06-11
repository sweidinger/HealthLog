"use client";

import { InsightsOverviewArrangeSection } from "@/components/settings/insights-overview-arrange-section";
import { InsightsPillOrderSection } from "@/components/settings/insights-pill-order-section";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.15.18 — the "Insights" settings section (analogous to the Dashboard
 * section). Hosts two blocks:
 *   1. Arrange the OVERVIEW — section show/hide + order, persisted to
 *      `insightsLayoutJson.sections` (the v1.15.11 inline edit mode).
 *   2. Sort the navigation PILLS — pill order, persisted to
 *      `insightsLayoutJson.tiles[].order` (already a separate field in v2).
 *
 * Both write through the same `/api/insights/layout` contract the tab strip
 * and the overview share, so a save here repaints both surfaces in lockstep.
 */
export function InsightsSection() {
  const { t } = useTranslations();

  return (
    <section
      aria-labelledby="settings-section-insights-title"
      className="space-y-6"
    >
      <header className="space-y-1">
        <h1 id="settings-section-insights-title" className="sr-only">
          {t("settings.sections.insights.title")}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t("settings.sections.insights.description")}
        </p>
      </header>

      <InsightsOverviewArrangeSection id="insights-overview-arrange" />
      <InsightsPillOrderSection id="insights-pill-order" />
    </section>
  );
}
