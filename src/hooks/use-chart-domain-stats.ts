"use client";

import { useCallback, useRef, useState } from "react";

import type { MetricWindowStats } from "@/lib/charts/window-stats";

/**
 * v1.12.7 — chart-reactive metric statistics.
 *
 * A metric sub-page lifts this hook so its `<HealthChart selectableDomain>`
 * (which mounts a Recharts `<Brush>`) and its `<MetricStatStrip>` read the
 * same brushed window. The chart reports the per-type Min / Max / Median /
 * Mean for the selected domain through `onDomainStats`; the strip reads
 * `statsByType[type]` and, when present, renders the windowed numbers in
 * place of the full-range summary.
 *
 * `null` (no selection, or a selection that collapsed to under one point)
 * means "show the full range" — the strip falls back to the precomputed
 * summary, so the default is unchanged and costs no extra work. The chart
 * owns the maths (it already holds the bucketed series), so the hook only
 * stores what it is handed and exposes a stable callback.
 *
 * The callback is referentially stable across renders so it can sit in the
 * chart's effect dependency list without re-firing. A shallow guard skips
 * the state write when the chart reports the same window twice in a row,
 * keeping a drag that lands on the same indices from thrashing the strip.
 */
export interface ChartDomainStats {
  /**
   * Per-type windowed stats, keyed by `MeasurementType`. Null means no
   * active selection (full range). A type may be absent from the map when
   * its series has no readings inside the brushed window — the strip falls
   * back to the full-range summary for that series.
   */
  statsByType: Record<string, MetricWindowStats> | null;
  /** True while a sub-range is selected (drives the "selected range" label). */
  isWindowed: boolean;
  /** Stable callback handed to `<HealthChart onDomainStats>`. */
  onDomainStats: (stats: Record<string, MetricWindowStats> | null) => void;
}

export function useChartDomainStats(): ChartDomainStats {
  const [statsByType, setStatsByType] = useState<Record<
    string,
    MetricWindowStats
  > | null>(null);
  const lastRef = useRef<string>("null");

  const onDomainStats = useCallback(
    (stats: Record<string, MetricWindowStats> | null) => {
      // Cheap shallow signature so an identical brush window (a drag that
      // settles on the same indices, or a re-render that recomputes the
      // same slice) doesn't re-set state and re-render the strip.
      const signature = stats === null ? "null" : JSON.stringify(stats);
      if (signature === lastRef.current) return;
      lastRef.current = signature;
      setStatsByType(stats);
    },
    [],
  );

  return {
    statsByType,
    isWindowed: statsByType !== null,
    onDomainStats,
  };
}
