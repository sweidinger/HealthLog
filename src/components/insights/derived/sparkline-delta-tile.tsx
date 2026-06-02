"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import {
  getTrendSentiment,
  sentimentColorClass,
  type TrendDirectionSentiment,
} from "@/lib/insights/trend-sentiment";

/**
 * v1.10.0 — the Apple-Health-Highlights grid tile.
 *
 * Extends the shipped `trend-card` grammar (label + icon row, big
 * `tabular-nums` value, sentiment-coloured trend arrow) with the single
 * biggest visible grid upgrade the design direction names: an inline
 * Recharts sparkline, a signed period delta, and an age / normal-range
 * framing slot. Reuses the already-imported Recharts (Area sparkline,
 * 40–60px fixed height) — 0 KB new runtime.
 *
 * States, defined up front (no fallback afterthought):
 *  - populated: value + sparkline + delta + framing line
 *  - empty (`value == null`): em-dash, no sparkline, optional framing line
 *  - stale (`staleDays`): "last value Xd ago" caption, value kept visible
 * Fixed footprint so a tile never reflows its neighbours.
 */

export interface SparklineDeltaTileProps {
  label: string;
  /** Latest reading; `null` renders the empty state. */
  value: number | null;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Trailing sparkline points (oldest → newest). < 2 points suppresses the
   * sparkline (a line needs at least two). Reuses Recharts, capped to a
   * small fixed height.
   */
  series?: number[];
  /** Signed delta vs the baseline; drives the arrow + the (Δ) caption. */
  delta?: number | null;
  /** Whether an up move is good / bad / neutral for this metric. */
  directionSentiment?: TrendDirectionSentiment;
  /**
   * The age / normal-range framing line (e.g. "typical for age 31",
   * "~5 yrs younger", "within normal range"). Plain text children — no
   * markdown. Rendered muted under the value row.
   */
  framing?: React.ReactNode;
  /** Days since the last reading; > 7 surfaces the stale caption. */
  staleDays?: number | null;
  /** Decimal places for the value + delta. Defaults to 1. */
  precision?: number;
  /**
   * Optional provenance affordance — the `ProvenanceExplainer` ⓘ trigger
   * rendered in the label row so the method + cited standard reach the user
   * on a tile that has no detail page (vitals baseline, HRV, BMI,
   * fitness/vascular age). Plain element children — the caller wires the
   * explainer; the tile just gives it a slot.
   */
  provenance?: React.ReactNode;
  className?: string;
}

export function SparklineDeltaTile({
  label,
  value,
  unit,
  icon: Icon,
  series,
  delta = null,
  directionSentiment = "neutral",
  framing,
  staleDays = null,
  precision = 1,
  provenance,
  className,
}: SparklineDeltaTileProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const arrowSentiment = getTrendSentiment(delta ?? null, directionSentiment);
  const trendColor = sentimentColorClass(arrowSentiment);

  const TrendIcon = ((): typeof ArrowUp => {
    if (delta == null) return Minus;
    if (Math.abs(delta) < 0.05) return ArrowRight;
    return delta > 0 ? ArrowUp : ArrowDown;
  })();

  const formatDelta = (d: number): string => {
    if (Math.abs(d) < 0.05) return "±0";
    const sign = d > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(d), precision)}`;
  };

  const sparkData =
    series && series.length >= 2
      ? series.map((v, i) => ({ i, v }))
      : null;

  // The sparkline tints with the trend sentiment so it reads "same signal"
  // as the arrow; neutral metrics ride the muted-foreground line.
  // Semantic tokens, not raw --dracula-*, so the sparkline tint tracks the
  // AA-safe :root.light overrides on the white card (the band-token fix).
  const strokeVar =
    arrowSentiment === "positive"
      ? "var(--success)"
      : arrowSentiment === "negative"
        ? "var(--warning)"
        : "var(--muted-foreground)";
  const fillId = `spark-${label.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <div
      data-slot="sparkline-delta-tile"
      className={cn(
        "bg-card border-border flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border p-4 md:p-6",
        className,
      )}
    >
      <div className="flex h-5 min-w-0 items-center justify-between gap-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs leading-5 font-medium tracking-wide whitespace-nowrap uppercase"
          data-slot="sparkline-delta-tile-label"
        >
          {label}
        </span>
        {provenance ? (
          <span
            data-slot="sparkline-delta-tile-provenance"
            className="shrink-0"
          >
            {provenance}
          </span>
        ) : null}
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
      </div>

      <div
        className="mt-2 flex items-baseline gap-x-1.5"
        data-slot="sparkline-delta-tile-value-row"
      >
        <span
          className="shrink-0 text-3xl leading-none font-semibold tracking-tight whitespace-nowrap tabular-nums"
          data-slot="sparkline-delta-tile-value"
        >
          {value !== null ? fmt.number(value, precision) : "—"}
        </span>
        <span className="text-muted-foreground min-w-0 truncate text-sm tabular-nums">
          {unit}
        </span>
        <span
          className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
          data-slot="sparkline-delta-tile-arrow"
          aria-hidden="true"
        >
          {delta != null ? (
            <TrendIcon className={cn("h-4 w-4", trendColor)} />
          ) : (
            <span className="text-muted-foreground text-xs opacity-30">—</span>
          )}
        </span>
      </div>

      {/* Inline sparkline — fixed 40px height so the tile never reflows.
          When there is no trailing series the row collapses entirely rather
          than reserving an empty dashed placeholder (which read as visual
          dead space across the whole grid). */}
      {sparkData ? (
        <div className="mt-3 h-10 w-full" data-slot="sparkline-delta-tile-spark">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={sparkData}
              margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
            >
              <defs>
                <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={strokeVar} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={strokeVar} stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Area
                type="monotone"
                dataKey="v"
                stroke={strokeVar}
                strokeWidth={1.5}
                fill={`url(#${fillId})`}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {/* Framing + delta caption row. */}
      <div className="mt-2 flex min-h-[18px] items-baseline justify-between gap-2">
        {framing ? (
          <span
            className="text-muted-foreground min-w-0 flex-1 truncate text-xs leading-snug"
            data-slot="sparkline-delta-tile-framing"
          >
            {framing}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {delta != null && (
          <span
            className={cn(
              "shrink-0 text-xs font-medium tabular-nums",
              trendColor,
            )}
            data-slot="sparkline-delta-tile-delta"
            aria-label={`${formatDelta(delta)} ${unit}`.trim()}
          >
            {formatDelta(delta)}
          </span>
        )}
      </div>

      {staleDays != null && staleDays > 7 && (
        <span
          className="text-muted-foreground mt-1 line-clamp-1 text-xs leading-snug tabular-nums"
          data-slot="sparkline-delta-tile-stale"
          data-stale-days={staleDays}
        >
          {t("dashboard.staleHint", { count: staleDays })}
        </span>
      )}
    </div>
  );
}
