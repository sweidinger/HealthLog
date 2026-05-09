"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations, useFormatters } from "@/lib/i18n/context";

interface SecondaryMetric {
  /** Sub-value latest reading (e.g. diastolic when latest is systolic). */
  latest: number | null;
  avg7: number | null;
  avg30: number | null;
}

/**
 * Maps a metric's "up means" direction to colour sentiment for the small
 * trend arrow on each tile. v1.4.6 P4 stripped the colour entirely after
 * the original up=red / down=green mapping was wrong for half the metrics
 * (mood up = good, BP up = bad, pulse up = neutral). v1.5 phase-5 restores
 * the colour but per-metric:
 *
 *   - `up-good`   — higher value is better (mood, sleep hours, steps).
 *                   ↑ green, ↓ orange.
 *   - `up-bad`    — higher value is worse (BP, weight, body fat).
 *                   ↑ orange, ↓ green.
 *   - `neutral`   — direction doesn't carry a value judgement (pulse,
 *                   "BP in target %" — those have their own range
 *                   colouring on the avg7/avg30 numbers already).
 *
 * Strictly affects the ↑/↓/→ arrow next to the latest reading. Chart
 * lines, axes, and the avg7/avg30 colour classes are untouched.
 */
export type TrendDirectionSentiment = "up-good" | "up-bad" | "neutral";

interface TrendCardProps {
  label: string;
  latest: number | null;
  unit: string;
  avg7: number | null;
  avg30: number | null;
  avg7ColorClass?: string;
  avg30ColorClass?: string;
  avg7Hint?: React.ReactNode;
  avg30Hint?: React.ReactNode;
  slope30: TrendSlope | null;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Whether an upward slope is good, bad, or neutral for this metric.
   * Defaults to `"neutral"` so existing call sites that haven't been
   * updated keep the v1.4.6 behaviour (muted-foreground arrow).
   */
  directionSentiment?: TrendDirectionSentiment;
  /** Optional second value rendered next to the primary as `X / Y` (used for
   *  paired metrics like blood-pressure systolic/diastolic so a single tile
   *  shows both numbers). */
  secondary?: SecondaryMetric;
  /**
   * v1.4.15 Fix 4 — 7-day trend delta. When provided, the avg7 line
   * shows a signed delta (e.g. "+1.2 kg") next to the average and the
   * label switches from `charts.avg7dShort` (just "7d") to
   * `charts.trend7dShort` ("7d trend"). Color of the delta follows the
   * same `directionSentiment` rules as the headline arrow:
   *   - up-good metric, positive delta → green
   *   - up-bad metric, positive delta → orange
   *   - neutral metric → muted regardless of sign
   *
   * Pass `null` (default) to keep the legacy avg-only behaviour for
   * call sites that haven't been migrated yet.
   */
  trend7Delta?: number | null;
}

export function TrendCard({
  label,
  latest,
  unit,
  avg7,
  avg30,
  avg7ColorClass,
  avg30ColorClass,
  avg7Hint,
  avg30Hint,
  slope30,
  icon: Icon,
  directionSentiment = "neutral",
  secondary,
  trend7Delta = null,
}: TrendCardProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const TrendIcon =
    slope30?.direction === "up"
      ? ArrowUp
      : slope30?.direction === "down"
        ? ArrowDown
        : slope30
          ? ArrowRight
          : Minus;

  // v1.5: per-metric arrow sentiment. Flat ("→") and "no slope yet" ("—")
  // always stay muted; only an actual rise / fall paints colour, and the
  // colour direction depends on what's good for *this* metric. The
  // `text-muted-foreground` default keeps every metric tagged `neutral`
  // (pulse, BP-in-target %) visually identical to v1.4.6.
  const trendColor = ((): string => {
    // No data yet (Minus icon) or a "stable" slope (ArrowRight) stays muted —
    // we don't celebrate or scold a flat metric.
    if (!slope30 || slope30.direction === "stable") {
      return "text-muted-foreground";
    }
    if (directionSentiment === "neutral") return "text-muted-foreground";
    const isUp = slope30.direction === "up";
    const isGood =
      (directionSentiment === "up-good" && isUp) ||
      (directionSentiment === "up-bad" && !isUp);
    return isGood ? "text-dracula-green" : "text-dracula-orange";
  })();

  const formatValue = (value: number) => fmt.number(value, 1);

  // v1.4.15 Fix 4 — color the 7-day delta with the same metric-aware
  // sentiment rules the headline arrow already uses. Tiny absolute
  // deltas (< 0.05) read as "no movement" and stay muted.
  const deltaColor = ((): string => {
    if (trend7Delta == null || Math.abs(trend7Delta) < 0.05) {
      return "text-muted-foreground";
    }
    if (directionSentiment === "neutral") return "text-muted-foreground";
    const isUp = trend7Delta > 0;
    const isGood =
      (directionSentiment === "up-good" && isUp) ||
      (directionSentiment === "up-bad" && !isUp);
    return isGood ? "text-dracula-green" : "text-dracula-orange";
  })();

  const formatDelta = (value: number): string => {
    if (Math.abs(value) < 0.05) return `±0`;
    const sign = value > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(value), 1)}`;
  };

  // The label flips from "7d" / "7T" (mean) to "7d trend" / "7T-Trend"
  // when the call site supplies a delta. Marc's v1.4.15 feedback —
  // "7-Tage-Schnitt" sounds like an average, but the value next to it
  // is now a TREND. Distinct keys keep the label change in i18n.
  const avg7LabelKey =
    trend7Delta != null ? "charts.trend7dShort" : "charts.avg7dShort";

  const renderPair = (
    primary: number | null,
    secondaryValue: number | null | undefined,
  ): string => {
    if (primary === null) return "—";
    if (secondary && secondaryValue !== null && secondaryValue !== undefined) {
      return `${formatValue(primary)}/${formatValue(secondaryValue)}`;
    }
    return formatValue(primary);
  };

  return (
    <div className="bg-card border-border flex h-full w-full flex-col rounded-xl border p-4 md:p-6">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </span>
        <Icon className="text-muted-foreground h-4 w-4" />
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-bold tracking-tight tabular-nums">
          {latest !== null ? renderPair(latest, secondary?.latest) : "—"}
        </span>
        <span className="text-muted-foreground text-sm tabular-nums">
          {unit}
        </span>
        {slope30 && <TrendIcon className={`h-4 w-4 ${trendColor}`} />}
      </div>
      <TooltipProvider>
        <div className="text-muted-foreground mt-auto flex gap-3 pt-1 text-xs">
          <span>
            {t(avg7LabelKey)}:{" "}
            {avg7Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn("font-medium tabular-nums", avg7ColorClass)}
                  >
                    {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg7Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className={cn("font-medium tabular-nums", avg7ColorClass)}>
                {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
              </span>
            )}
            {trend7Delta != null && (
              <span
                className={cn("ml-1 font-medium tabular-nums", deltaColor)}
                data-slot="trend7-delta"
                aria-label={`7-day trend ${formatDelta(trend7Delta)}`}
              >
                ({formatDelta(trend7Delta)})
              </span>
            )}
          </span>
          <span>
            {t("charts.avg30dShort")}:{" "}
            {avg30Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn("font-medium tabular-nums", avg30ColorClass)}
                  >
                    {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg30Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span className={cn("font-medium tabular-nums", avg30ColorClass)}>
                {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
              </span>
            )}
          </span>
        </div>
      </TooltipProvider>
    </div>
  );
}
