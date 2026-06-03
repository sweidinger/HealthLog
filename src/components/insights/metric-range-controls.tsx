"use client";

import { useInsightsRangePref } from "@/hooks/use-insights-layout-prefs";
import { useAnalyticsRange } from "@/hooks/use-analytics-range";
import {
  getMetricStatusMeta,
  metricIdForMeasurementType,
} from "@/lib/insights/metric-status-registry";
import { sentimentFromMetricDirection } from "@/lib/insights/trend-sentiment";
import type { MeasurementType } from "@/generated/prisma/client";
import { TimeRangePills } from "@/components/insights/time-range-pills";
import { MetricRangeDelta } from "@/components/insights/metric-range-delta";

/**
 * v1.10.2 — shared range-controls block (time-range pills +
 * period-over-period delta) lifted out of `<HealthKitMetricPage>` so the
 * bespoke metric sub-pages (`weight`, `blood-pressure`, `pulse`, `mood`,
 * `sleep`, `bmi`, …) render the identical control.
 *
 * Before this, the 37 HealthKit pages carried the selector and the 8
 * hand-rolled pages carried nothing, so navigating from an HK metric to
 * `weight` made the control vanish. This component is the single source the
 * HK scaffold and the bespoke pages both consume, wired to the same
 * persisted range pref (`useInsightsRangePref`) so the choice sticks across
 * every metric.
 *
 * The delta's sentiment colour follows the metric's "good direction" from
 * the metric-status registry (higher-better → up-good, lower-better →
 * up-bad, target-band → neutral); a metric absent from the registry falls
 * back to neutral.
 */
export function MetricRangeControls({
  measurementType,
  enabled = true,
}: {
  /** The MeasurementType the period-over-period read is keyed on. */
  measurementType: string;
  /**
   * Gate the range read. Pages pass `!isEmpty` so a brand-new metric with
   * no observations never fires the round-trip. Defaults to `true`.
   */
  enabled?: boolean;
}) {
  const { range, setRange } = useInsightsRangePref();
  const { data: rangeData, isLoading: isRangeLoading } = useAnalyticsRange(
    measurementType,
    range,
    enabled,
  );

  const registryMeta = (() => {
    const id = metricIdForMeasurementType(measurementType as MeasurementType);
    return id ? getMetricStatusMeta(id) : null;
  })();
  const directionSentiment = registryMeta
    ? sentimentFromMetricDirection(registryMeta.direction)
    : "neutral";

  return (
    <div
      data-slot="metric-range-controls"
      className="flex flex-wrap items-center justify-between gap-2"
    >
      <TimeRangePills value={range} onChange={setRange} />
      <MetricRangeDelta
        data={rangeData}
        range={range}
        directionSentiment={directionSentiment}
        isLoading={isRangeLoading}
      />
    </div>
  );
}
