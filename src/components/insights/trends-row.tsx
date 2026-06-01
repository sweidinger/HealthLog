"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { HealthChartDynamicMini } from "@/components/charts/health-chart-dynamic";
import type { DailyBriefing } from "@/lib/ai/schema";
import {
  selectTrendCharts,
  type TrendAnnotationKey,
  type TrendChartConfig,
} from "@/lib/insights/trend-chart-select";
import {
  TrendAnnotation,
  type TrendAnnotationConfidenceBand,
  type TrendAnnotationStatus,
} from "./trend-annotation";

/**
 * Trends row — a small chart per metric above a one-sentence
 * assessment. Recharts is ~108 KiB Brotli, so the charts ride the
 * shared lazy-import boundary (`<HealthChartDynamicMini>` for every
 * measurement series; `<MoodChart>` resolves locally because no shared
 * re-export exists for it yet).
 *
 * v1.8.5 — the chart set is DYNAMIC. It mirrors the daily briefing:
 * the row charts exactly the metrics the briefing flags, in the
 * briefing's priority order, deduped and capped (top three). When no
 * briefing is available — cold mount, web-only account with no
 * findings, or a pre-briefing cached payload — `selectTrendCharts`
 * falls back to the legacy BP / weight / mood triple so the row never
 * paints empty. Selection lives in `@/lib/insights/trend-chart-select`
 * (pure + unit-tested); this component is the renderer.
 *
 * Layout:
 *   - `<md`: single column, full width
 *   - `>=md`: 3-up grid, equal column tracks
 *
 * Annotations come from `trendAnnotations.{bp,weight,mood}` on the
 * Insights payload and only attach to those three slots (the advisor
 * authors annotations for the legacy triple). Additive metrics render
 * chart-only. When a slot's annotation is null, `<TrendAnnotation>`'s
 * empty state hints at the gap without breaking the row's rhythm.
 */

const MoodChart = dynamic(
  () =>
    import("@/components/charts/mood-chart").then((mod) => ({
      default: mod.MoodChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton mini /> },
);

interface TrendsRowProps {
  /**
   * Daily briefing payload. Drives the chart set: the row charts the
   * metrics the briefing flags, in order, deduped + capped. `null` /
   * omitted → the default BP / weight / mood triple.
   */
  briefing?: DailyBriefing | null;
  /**
   * Assistant-authored one-sentence annotations, keyed by metric. Only
   * the legacy triple (bp / weight / mood) carries annotations.
   * Optional — legacy advisor payloads (pre-PROMPT_VERSION 4.20.1)
   * won't carry the field.
   */
  annotations?: {
    bp?: string | null;
    weight?: string | null;
    mood?: string | null;
  } | null;
  /**
   * Optional per-metric confidence bands surfaced as small chips below
   * each annotation. When omitted, the annotation renders without a
   * chip.
   */
  confidence?: {
    bp?: TrendAnnotationConfidenceBand;
    weight?: TrendAnnotationConfidenceBand;
    mood?: TrendAnnotationConfidenceBand;
  };
  /**
   * v1.4.36 W2 T3 — advisor query / mutation in flight. When true,
   * every per-metric annotation slot paints a pending shimmer instead
   * of the "Mehr Daten nötig" empty hint. Resolves the recurring
   * complaint where the empty hint flashed across all three metrics
   * while the advisor was generating fresh annotations.
   */
  loading?: boolean;
}

function MetricChart({ config, title }: { config: TrendChartConfig; title: string }) {
  const { user } = useAuth();
  const userTimezone = user?.timezone;
  if (config.kind === "mood") {
    return <MoodChart title={title} mini userTimezone={userTimezone} />;
  }
  return (
    <HealthChartDynamicMini
      types={config.types}
      title={title}
      colors={config.colors}
      unit={config.unit}
      yAxisUnit={config.yAxisUnit}
      mini
      userTimezone={userTimezone}
    />
  );
}

export function TrendsRow({
  briefing,
  annotations,
  confidence,
  loading = false,
}: TrendsRowProps) {
  const { t } = useTranslations();

  // v1.8.5 — derive the chart set from the briefing. No new fetch: the
  // briefing payload is already on the page (advisor cache), so this is
  // a pure read that respects the v1.8.3 anti-freeze contract.
  const charts = selectTrendCharts(briefing);

  // v1.4.36 W2 T3 — derive the tri-state status per metric from the
  // advisor's loading flag + the annotation presence. Pending wins
  // over needs_data so a mid-generation regenerate doesn't flash the
  // empty hint between the spinner and the new prose.
  const statusFor = (annotation: string | null): TrendAnnotationStatus => {
    if (loading) return "pending";
    return annotation ? "generated" : "needs_data";
  };

  const annotationFor = (key: TrendAnnotationKey): string | null =>
    annotations?.[key] ?? null;

  return (
    <section
      data-slot="trends-row"
      aria-label={t("insights.trendsRow.title")}
      className="space-y-3"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          {t("insights.trendsRow.title")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("insights.trendsRow.subtitle")}
        </p>
      </div>
      {/* v1.4.22 A4 — equal-height cards. The annotation prose
          below each chart varies in length, which used to leave the
          three cards on visibly different baselines. Each card is now
          a flex column with `min-h-[300px]` so the chart anchors to
          the top and the annotation grows downward into a shared
          minimum height.
          v1.4.25 W3 — strengthen the equal-height contract with
          `md:auto-rows-fr` + `md:items-stretch` on the grid and
          `h-full` on each card so the tallest annotation still pins
          every row member to a single baseline.

          v1.4.27 MB7 / CF-71 — drop the unconditional `min-h-[300px]`
          floor to `md:min-h-[300px]` so mobile single-column doesn't
          eat dead space below a short chart; the floor stays on `md+`
          to preserve the equal-height baseline across the row.

          v1.4.28 R3c-Insights (FB-K1/K2) — three-slot template.
          `auto-rows-fr` covers every viewport, not just `md+`, so the
          mobile single-column path picks up the same row contract
          when the user expands the strip side-by-side via the
          orientation-change. The chart slot is now wrapped in a
          fixed-height shell so the series paint at the same vertical
          position; the annotation slot clamps via `<TrendAnnotation>`
          so long captions can't pull the row taller than the design
          constant.

          v1.8.5 — the cards are now rendered from the dynamic chart
          set instead of three hard-coded tiles. The grid + slot
          contract is unchanged; the card count tracks the briefing
          (capped at three so the 3-up template still holds). */}
      <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-3 md:items-stretch">
        {charts.map((config) => {
          const title = t(config.titleKey);
          return (
            <div
              key={config.metric}
              data-slot="trends-row-card"
              data-metric={config.metric}
              className="flex h-full flex-col gap-2 md:min-h-[300px]"
            >
              {/* v1.4.28 R3c-Insights — fixed chart slot. The mini
                  chart paints its own band; this wrapper pins the
                  total chart-envelope height so every tile lines up on
                  a single baseline regardless of the chart kind. */}
              <div
                data-slot="trends-row-chart-slot"
                className="h-[180px] shrink-0"
              >
                <MetricChart config={config} title={title} />
              </div>
              {config.annotationKey ? (
                <TrendAnnotation
                  metric={config.annotationKey}
                  annotation={annotationFor(config.annotationKey)}
                  confidence={confidence?.[config.annotationKey]}
                  status={statusFor(annotationFor(config.annotationKey))}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
