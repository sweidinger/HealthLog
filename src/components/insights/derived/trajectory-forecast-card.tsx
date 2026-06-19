"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { LearningGate } from "@/components/ui/learning-gate";
import { CoverageMeter } from "@/components/insights/derived/coverage-meter";
import { ProvenanceExplainer } from "@/components/insights/derived/provenance-explainer";
import { METRIC_PROVENANCE } from "@/components/insights/derived/standards";
import { useDerivedMetric } from "@/components/insights/derived/use-derived-metric";

// v1.12.1 — defer the Recharts fan band so the card chrome (and the whole
// HealthKit metric page that always mounts this card on a trajectory-
// eligible type) no longer pulls Recharts into the initial chunk. The
// loading shell is a plain box that fills the same fixed-height band the
// chart paints, so there is no layout shift when the chunk arrives.
const TrajectoryFanDynamic = dynamic(
  () =>
    import("@/components/insights/derived/trajectory-fan").then((mod) => ({
      default: mod.TrajectoryFan,
    })),
  {
    ssr: false,
    loading: () => <div className="bg-muted/20 h-full w-full rounded" />,
  },
);
// Type-only — the compute payload never drags the server graph into the
// client bundle (the v1.9.0 lesson, mirrored across the derived surfaces).
import type { TrajectoryValue } from "@/lib/insights/derived/trajectory";
import type { DerivedProvenance } from "@/lib/insights/derived/types";

/**
 * v1.11.0 (Epic B, Pillar 3) — the short-horizon projection card on the
 * metric detail page.
 *
 * Surfaces the deterministic `TRAJECTORY` derived metric as a small band
 * chart: the recent observed line, then the projected line (dashed) with a
 * widening prediction-interval fan. The fan VISIBLY widens with the horizon
 * — that is the uncertainty communication, no words needed. The number is
 * computed server-side; this card only draws it. It is explicitly labelled
 * a PROJECTION ("if this pattern continues"), never a prediction or a dated
 * event, and the cited method (OLS + prediction interval) rides the ⓘ
 * provenance affordance.
 *
 * Below the engine's R² / history / staleness floor the engine returns
 * `insufficient`, and the card renders the same calm "not enough of a trend
 * to project yet" + coverage state every derived surface uses — never a weak
 * line, never a blank.
 *
 * The card mounts as a sibling beneath the main metric chart (mirroring
 * `MetricStatusCard`), so the main chart's visual identity is untouched.
 */

const TRAJECTORY_METRIC = "TRAJECTORY";

/**
 * Mirror of `TRAJECTORY_MIN_HISTORY_DAYS` (`src/lib/insights/derived/trajectory.ts`).
 * Re-declared as a client-side literal rather than value-imported because the
 * engine module pulls the rollup/baseline server graph in at its top level —
 * importing the constant would drag that graph into the client bundle (the same
 * reason `TrajectoryValue` is a type-only import). Keep this in lockstep with
 * the engine; the unit test pins both at 14.
 */
const TRAJECTORY_MIN_HISTORY_DAYS = 14;

/** A single value-scale used to render stored values in the display unit. */
function scaled(value: number, scale: number): number {
  return value * scale;
}

interface TrajectoryForecastCardProps {
  /** The MeasurementType to project (the page's canonical type). */
  type: string;
  /** Display unit suffix (e.g. "kg"). */
  unit?: string;
  /** Display scale folded into every rendered value (defaults to 1). */
  valueScale?: number;
  /** Canonical chart colour for the metric's line. */
  color?: string;
  /** Gate the underlying derived read (e.g. on the auth/empty flag). */
  enabled?: boolean;
  /**
   * v1.12.0 — density by render context. Sub-pages pass `compact` so the
   * card sheds the `min-h-48` floor + drops to a shorter chart and a tighter
   * no-trend state (a too-tall "1 of 1" empty band was the maintainer flag).
   * The Insights OVERVIEW grid omits it so the tile KEEPS its current size
   * for grid symmetry — the default is the unchanged, roomier geometry.
   */
  compact?: boolean;
  className?: string;
}

/** The provenance ⓘ explainer for the projection, wired from the map. */
function TrajectoryProvenance({
  provenance,
}: {
  provenance: DerivedProvenance;
}) {
  const { t } = useTranslations();
  const meta = METRIC_PROVENANCE.TRAJECTORY;
  const method = (
    <>
      {meta.caveatKey ? (
        <span className="text-warning block font-medium">
          {t(meta.caveatKey)}
        </span>
      ) : null}
      {t(meta.methodKey)}
    </>
  );
  return (
    <ProvenanceExplainer
      provenance={provenance}
      method={method}
      standard={meta.standard}
    />
  );
}

/** Card shell — uppercase label + provenance affordance + body children. */
function CardShell({
  provenance,
  compact = false,
  children,
}: {
  provenance?: DerivedProvenance;
  compact?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <div
      data-slot="trajectory-forecast-card"
      data-density={compact ? "compact" : "default"}
      className={cn(
        "bg-card border-border flex w-full min-w-0 flex-col gap-2 rounded-xl border",
        // Overview keeps the roomy `min-h-48` + `p-4 md:p-6` geometry for grid
        // symmetry; sub-pages drop the height floor and tighten the padding so
        // the no-trend state stops opening a tall empty band.
        compact ? "p-4" : "min-h-48 p-4 md:p-6",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
          {t("insights.derived.trajectory.cardTitle")}
        </span>
        {provenance ? <TrajectoryProvenance provenance={provenance} /> : null}
      </div>
      {children}
    </div>
  );
}

/** CLS-safe skeleton matching the resolved card geometry. */
function CardSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-slot="trajectory-forecast-card-skeleton"
      aria-hidden="true"
      className={cn(
        "bg-card border-border flex w-full min-w-0 flex-col gap-2 rounded-xl border",
        compact ? "p-4" : "min-h-48 p-4 md:p-6",
      )}
    >
      <div className="flex h-11 items-center justify-between gap-2">
        <div className="bg-muted/40 h-3 w-32 rounded" />
        <div className="bg-muted/40 h-5 w-5 rounded-full" />
      </div>
      <div
        className={cn("bg-muted/40 w-full rounded", compact ? "h-12" : "h-24")}
      />
    </div>
  );
}

export function TrajectoryForecastCard({
  type,
  unit,
  valueScale = 1,
  color = "var(--chart-1)",
  enabled = true,
  compact = false,
  className,
}: TrajectoryForecastCardProps) {
  const { t } = useTranslations();
  const { data } = useDerivedMetric<TrajectoryValue>(TRAJECTORY_METRIC, {
    type,
    enabled,
  });

  // Assemble the band chart series: the projected fan only (the engine
  // returns the projection points; the recent observed value anchors it as
  // the dashed line's left edge). Each projection point carries the band
  // `low`/`base` (= bandLow) + `range` (= bandHigh − bandLow) so a stacked
  // Area renders the fan, plus the projected line.
  const chart = useMemo(() => {
    if (!data || data.status !== "ok" || !data.value) return null;
    const v = data.value;
    const points = v.projection.map((p) => ({
      date: p.date,
      projected: scaled(p.projected, valueScale),
      base: scaled(p.bandLow, valueScale),
      range: scaled(p.bandHigh - p.bandLow, valueScale),
    }));
    // Anchor the fan at the last observed value so the dashed line departs
    // from "today" rather than floating.
    const anchor = {
      date: "now",
      projected: scaled(v.lastValue, valueScale),
      base: scaled(v.lastValue, valueScale),
      range: 0,
    };
    return {
      points: [anchor, ...points],
      lastValue: scaled(v.lastValue, valueScale),
    };
  }, [data, valueScale]);

  if (!data) {
    return (
      <div className={className}>
        <CardSkeleton compact={compact} />
      </div>
    );
  }

  // Below the fit / history / staleness floor — calm "no trend to project"
  // state + coverage, never a weak line.
  if (data.status === "insufficient" || !chart) {
    // v1.12.0 — surface how much history is still missing before a projection
    // can appear, drawn from the same coverage envelope the meter reads. The
    // gating floor is distinct-in-window days, so the hint only shows when the
    // shortfall is a history-depth one (the dominant insufficient cause); when
    // the shortfall is fit quality (enough days, weak R²) the days are already
    // there and the generic copy stands on its own.
    const daysNeeded = Math.max(
      0,
      TRAJECTORY_MIN_HISTORY_DAYS - Math.floor(data.coverage.historyDays),
    );
    return (
      <div className={className}>
        <CardShell provenance={data.provenance} compact={compact}>
          <LearningGate
            compact={compact}
            bodySlot="trajectory-insufficient"
            message={t("insights.derived.trajectory.insufficient")}
            caveat={
              daysNeeded > 0
                ? t("insights.derived.trajectory.daysNeeded", {
                    count: daysNeeded,
                  })
                : undefined
            }
          />
          <CoverageMeter coverage={data.coverage} />
        </CardShell>
      </div>
    );
  }

  const v = data.value!;
  const DirectionIcon =
    v.direction === "up"
      ? TrendingUp
      : v.direction === "down"
        ? TrendingDown
        : Minus;
  const last = chart.points[chart.points.length - 1];
  const projectedLow = last.base;
  const projectedHigh = last.base + last.range;

  // The headline is conditional by construction — "if this pattern
  // continues" — and quotes the RANGE, never a single certain number.
  const rangeText = t("insights.derived.trajectory.range", {
    low: Math.round(projectedLow * 10) / 10,
    high: Math.round(projectedHigh * 10) / 10,
    unit: unit ?? "",
    days: v.horizonDays,
  });

  return (
    <div className={className}>
      <CardShell provenance={data.provenance} compact={compact}>
        <div className="flex items-start gap-2">
          <DirectionIcon
            className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            <p
              className="text-foreground text-sm font-medium"
              data-slot="trajectory-headline"
            >
              {t("insights.derived.trajectory.headline", {
                days: v.horizonDays,
              })}
            </p>
            <p
              className="text-muted-foreground text-xs leading-snug"
              data-slot="trajectory-range"
            >
              {rangeText}
            </p>
          </div>
        </div>

        {/* The fan: a stacked transparent base + a shaded range Area, then
            the dashed projected line. The shaded band visibly widens toward
            the horizon — the uncertainty signal. */}
        <div
          className={cn("w-full", compact ? "h-20" : "h-28")}
          data-slot="trajectory-chart"
        >
          <TrajectoryFanDynamic points={chart.points} color={color} />
        </div>

        {/* The mandatory conditional caveat — never a certainty, never a
            dated clinical event. */}
        <p
          className={cn("text-muted-foreground text-xs leading-snug")}
          data-slot="trajectory-caveat"
        >
          {t("insights.derived.trajectory.caveat")}
        </p>
      </CardShell>
    </div>
  );
}
