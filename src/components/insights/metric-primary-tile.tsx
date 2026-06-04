"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { DataSummary } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";

/**
 * v1.12.0 — canonical metric primary tile.
 *
 * The first data block on every per-metric detail page, mirroring the
 * iOS `InsightsPrimaryTile`:
 *
 *   • the headline value — the latest reading (the single place on the
 *     page the headline number appears; the stat strip below carries
 *     min / max / median / mean, not the latest),
 *   • the 30-Tage-Durchschnitt (`summary.avg30`) as a secondary line,
 *   • an "Im Zielbereich" bar — the share of logged days in target over
 *     the last 30, shown ONLY when the metric carries a per-metric pct
 *     (a registered target band feeds `/api/insights/targets`).
 *
 * Self-suppressing: renders nothing without a summary or with a
 * zero-count series (the page empty-state owns that surface). The
 * in-target bar omits itself when the slug has no numeric target or the
 * route flagged insufficient data, so a target-less metric (HRV, SpO₂,
 * temperature, …) reads as a clean headline + 30-day average.
 *
 * Blood pressure does NOT use this tile — its richer BP target panel is
 * its primary tile (the page omits this component and leads with
 * `<MetricTargetSummary slug="blood-pressure" />`).
 */

interface TargetRange {
  min: number;
  max: number;
}

interface TargetItem {
  type: string;
  daysInRange30d: number;
  daysLogged30d: number;
  insufficientData: boolean;
  range: TargetRange | null;
}

interface TargetsResponse {
  targets: TargetItem[];
}

/**
 * Insights slug → target `type`. Mirrors `metric-target-summary.tsx`'s
 * map for the single-target metrics. Slugs absent from the map (HRV,
 * SpO₂, temperature, …) carry no in-target pct, so the bar suppresses.
 */
const SLUG_TO_TARGET_TYPE: Record<string, string> = {
  weight: "WEIGHT",
  bmi: "BMI",
  pulse: "PULSE",
  sleep: "SLEEP_DURATION",
};

interface MetricPrimaryTileProps {
  /**
   * Analytics summary for the page's `MeasurementType`. Null is allowed
   * so the parent doesn't gate on the network read finishing.
   */
  summary: DataSummary | null;
  /** Unit suffix rendered next to the value (e.g. `bpm`, `kg`). */
  unit: string;
  /**
   * Insights category slug (e.g. `"weight"`). When the slug maps to a
   * registered target, the tile reads the in-target pct from
   * `/api/insights/targets` and paints the "Im Zielbereich" bar. Omit
   * for metrics with no numeric target — the tile then shows headline +
   * 30-day average only.
   */
  slug?: string;
  /** Decimal precision for the formatted values. Defaults to 1. */
  fractionDigits?: number;
}

export function MetricPrimaryTile({
  summary,
  unit,
  slug,
  fractionDigits = 1,
}: MetricPrimaryTileProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();

  const targetType = slug ? SLUG_TO_TARGET_TYPE[slug] : undefined;

  const { data: targets } = useQuery({
    queryKey: queryKeys.insightsTargets(),
    queryFn: async () => {
      const res = await fetch("/api/insights/targets");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data as TargetsResponse;
    },
    enabled: isAuthenticated && targetType != null,
  });

  // Nothing to show until the summary lands or for a metric with no
  // readings — the page's empty-state covers the zero-data case.
  if (!summary || summary.count <= 0) return null;

  const headline =
    summary.latest === null
      ? "—"
      : `${fmt.number(summary.latest, fractionDigits)} ${unit}`;
  const avg30 =
    summary.avg30 === null
      ? null
      : `${fmt.number(summary.avg30, fractionDigits)} ${unit}`;

  // In-target share: fraction of logged days in the green band over the
  // last 30, read verbatim from the targets route (never recomputed).
  const target = targetType
    ? targets?.targets.find((entry) => entry.type === targetType)
    : undefined;
  const showShare =
    target != null &&
    target.range != null &&
    !target.insufficientData &&
    target.daysLogged30d > 0;
  const sharePct = showShare
    ? Math.round((target.daysInRange30d / target.daysLogged30d) * 100)
    : null;

  return (
    <section
      data-slot="metric-primary-tile"
      className="bg-card border-border space-y-3 rounded-xl border p-4"
    >
      <div className="space-y-0.5">
        <p
          data-slot="metric-primary-value"
          className="text-3xl font-semibold tabular-nums"
        >
          {headline}
        </p>
        {avg30 ? (
          <p className="text-muted-foreground text-sm">
            {t("insights.subPage.primary.avg30Label")}: {avg30}
          </p>
        ) : null}
      </div>

      {/* "Im Zielbereich" bar — share of the last 30 logged days inside
          the target band. Self-suppresses for target-less metrics and on
          insufficient data. */}
      {sharePct != null ? (
        <div data-slot="metric-primary-in-range" className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {t("insights.subPage.primary.inRangeLabel")}
            </p>
            <p className="text-sm font-medium tabular-nums">{sharePct}%</p>
          </div>
          <div
            className="bg-muted h-2 w-full overflow-hidden rounded-full"
            role="img"
            aria-label={t("insights.subPage.primary.inRangeAria", {
              pct: sharePct,
            })}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                sharePct >= 70 ? "bg-dracula-green" : "bg-dracula-orange",
              )}
              style={{ width: `${Math.min(100, Math.max(0, sharePct))}%` }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
