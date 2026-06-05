"use client";

import type { ComponentType } from "react";
import { Sigma } from "lucide-react";

import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { TileHeader } from "@/components/insights/tile-header";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.8.5 — at-a-glance stat strip for the insights category pages.
 *
 * Leads each metric page with the four central statistics — min / max /
 * median / mean — read straight from the already-fetched `summaries`
 * slice (`useInsightsAnalytics`). Zero new network: the layout shell and
 * the empty-state gate already warm the `["analytics", "summaries"]`
 * cache, so the strip is a pure render of cached numbers. This is the
 * numbers-first header Apple Health / Withings / Oura lead their detail
 * screens with — the single biggest "data-rich" lift per unit effort.
 *
 * Median sits alongside mean on purpose: a series with a handful of very
 * high or very low readings drags the mean away from the typical value,
 * and showing both makes that skew legible rather than hidden.
 *
 * The thin HealthKit pages (`HealthkitMetricPage`) mount this too so they
 * reach parity with the bespoke pages — a rich numeric header even where
 * there is no target band or AI assessment.
 */

interface MetricStatStripProps {
  /**
   * Analytics summary for the page's `MeasurementType`. Null is allowed
   * so the parent doesn't have to gate on the network read finishing —
   * the strip simply doesn't paint until the data lands. A zero-count
   * summary (brand-new metric) also renders nothing; the page's
   * empty-state owns that surface.
   */
  summary: DataSummary | null;
  /** Unit suffix rendered next to each value (e.g. `bpm`, `kg`). */
  unit: string;
  /**
   * Decimal precision for the formatted values. Defaults to 1 — enough
   * for weight (78.4) and HRV (41.5) without trailing noise on integer
   * metrics, which `Intl.NumberFormat` drops anyway.
   */
  fractionDigits?: number;
  /**
   * v1.12.4 — series caption rendered above the grid. Single-series metrics
   * pass the metric name (e.g. "Gewicht"); blood pressure stacks two strips
   * (systolic / diastolic) and labels each so the unified strip covers both
   * halves rather than silently dropping one. Also feeds the `aria-label`
   * for the section.
   *
   * v1.12.6 — the caption is now rendered through the canonical
   * `<TileHeader>` (white heading + white icon, matching the Einschätzung
   * card) rather than a small muted uppercase line, so every series block
   * leads with the same header language as the rest of the surface.
   */
  seriesLabel?: string;
  /**
   * v1.12.6 — leading glyph for the series `<TileHeader>`. Pass the metric's
   * icon component (e.g. `Scale`, `Heart`); blood pressure passes a
   * directional glyph per series. Defaults to a generic stats glyph so a
   * caller that supplies a `seriesLabel` without an icon still renders a
   * complete header.
   */
  icon?: ComponentType<{ className?: string }>;
}

export function MetricStatStrip({
  summary,
  unit,
  fractionDigits = 1,
  seriesLabel,
  icon,
}: MetricStatStripProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  // Nothing to show until the summary lands or for a metric with no
  // readings — the page's empty-state covers the zero-data case.
  if (!summary || summary.count <= 0) return null;

  const format = (value: number | null): string =>
    value === null ? "—" : `${fmt.number(value, fractionDigits)} ${unit}`;

  const cells: Array<{ key: string; label: string; value: number | null }> = [
    { key: "min", label: t("insights.subPage.stats.min"), value: summary.min },
    { key: "max", label: t("insights.subPage.stats.max"), value: summary.max },
    {
      key: "median",
      label: t("insights.subPage.stats.median"),
      value: summary.median,
    },
    {
      key: "mean",
      label: t("insights.subPage.stats.mean"),
      value: summary.mean,
    },
  ];

  return (
    <section
      data-slot="metric-stat-strip"
      aria-label={
        seriesLabel
          ? `${t("insights.subPage.stats.label")} — ${seriesLabel}`
          : t("insights.subPage.stats.label")
      }
      className="bg-card border-border space-y-3 rounded-xl border p-4"
    >
      {seriesLabel ? (
        <TileHeader icon={icon ?? Sigma} title={seriesLabel} />
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 [&>div]:min-h-[56px]">
        {cells.map((cell) => (
        <div
          key={cell.key}
          data-slot="metric-stat"
          data-stat={cell.key}
          className="space-y-1"
        >
          <p className="text-muted-foreground text-[10px] tracking-wide uppercase">
            {cell.label}
          </p>
          <p className="text-lg font-semibold tabular-nums">
            {format(cell.value)}
          </p>
        </div>
        ))}
      </div>
    </section>
  );
}
