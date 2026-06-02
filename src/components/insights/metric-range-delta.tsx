"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  getTrendSentiment,
  sentimentColorClass,
  type TrendDirectionSentiment,
} from "@/lib/insights/trend-sentiment";
import type { AnalyticsRangeData } from "@/hooks/use-analytics-range";
import type { AnalyticsRange } from "@/lib/analytics/range-delta";

/**
 * v1.9.0 — period-over-period delta caption beside the time-range pills.
 *
 * Renders "+3 % vs prior 30d" with the metric-aware sentiment colour the
 * dashboard tiles use (up-good vs up-bad). When the prior window has no data
 * it shows a neutral "no prior-period data" line instead of a misleading 0 %
 * (the `deltaPct` is null in that case). For `target-band` metrics the
 * sentiment is neutral, so the delta still shows magnitude + direction but
 * carries no good/bad colour — matching Oura's deviation framing for metrics
 * with no single good direction.
 */
export function MetricRangeDelta({
  data,
  range,
  directionSentiment,
  isLoading,
}: {
  data: AnalyticsRangeData | undefined;
  range: AnalyticsRange;
  directionSentiment: TrendDirectionSentiment;
  isLoading: boolean;
}) {
  const { t } = useTranslations();

  if (isLoading) {
    return (
      <span
        data-slot="metric-range-delta-pending"
        className="bg-muted/60 inline-block h-3.5 w-28 animate-pulse rounded motion-reduce:animate-none"
        aria-hidden="true"
      />
    );
  }

  const priorLabel = t(`insights.range.priorLabel.${range}`);

  // No comparison available — prior window empty, or current window empty.
  if (!data || data.delta === null || data.deltaPct === null) {
    return (
      <span
        data-slot="metric-range-delta-empty"
        className="text-muted-foreground text-xs"
      >
        {t("insights.range.noPriorData")}
      </span>
    );
  }

  const direction = getTrendSentiment(data.delta, directionSentiment);
  const colorClass = sentimentColorClass(direction);
  const pct = Math.round(Math.abs(data.deltaPct) * 100);

  // A perfectly stable metric (current mean == prior mean, or a rounded
  // delta of 0 %) reads neutral — a flat dash and "no change", never a
  // down-arrow with "−0%". The direction arrow is decoupled from the raw
  // sign so a zero delta never paints a misleading decrease.
  if (data.delta === 0 || pct === 0) {
    return (
      <span
        data-slot="metric-range-delta"
        data-direction="neutral"
        className="text-muted-foreground inline-flex items-center gap-1 text-xs"
      >
        <Minus className="h-3 w-3" aria-hidden="true" />
        <span>
          {t("insights.range.noChange")} {priorLabel}
        </span>
      </span>
    );
  }

  const isUp = data.delta > 0;
  const sign = isUp ? "+" : "−";

  return (
    <span
      data-slot="metric-range-delta"
      data-direction={direction}
      className={cn("inline-flex items-center gap-1 text-xs", colorClass)}
    >
      {isUp ? (
        <ArrowUp className="h-3 w-3" aria-hidden="true" />
      ) : (
        <ArrowDown className="h-3 w-3" aria-hidden="true" />
      )}
      <span>
        {sign}
        {pct}% {priorLabel}
      </span>
    </span>
  );
}
