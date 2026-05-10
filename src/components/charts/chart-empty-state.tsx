"use client";

import type { ReactElement, ReactNode } from "react";
import { LineChart as LineChartIcon } from "lucide-react";

/**
 * Sparse-data empty-state for chart wrappers (B1a v1.4.16).
 *
 * Per the maintainer's research §1A — "personal-baseline framing first" — when a
 * user has only 1-2 data points there's nothing useful to plot, so we
 * paint a friendly hint instead of a near-empty canvas. The hint reuses
 * the `lucide-react/LineChart` glyph the rest of the app uses for chart
 * surfaces, so it visually matches the chart-card shell that wraps it.
 *
 * Design constraints:
 *   - Same outer footprint as the painted chart (240-280 px tall) so
 *     the dashboard layout doesn't reflow when a chart drops to / out
 *     of the empty state.
 *   - i18n-driven copy — the wrapper passes already-translated strings.
 *   - SSR-safe — pure markup, tested via `renderToStaticMarkup`.
 */

export interface ChartEmptyStateProps {
  /** Translated headline, e.g. "Add more measurements to see trends". */
  title: string;
  /**
   * Optional secondary line. Sometimes useful to nudge the user toward
   * a specific action ("3 measurements minimum"); often omitted.
   */
  description?: ReactNode;
  /**
   * Optional explicit height in pixels to match the surrounding chart
   * card. Defaults to 240 (matches `<HealthChart>` /
   * `<MedicationComplianceChart>`).
   */
  height?: number;
}

export function ChartEmptyState({
  title,
  description,
  height = 240,
}: ChartEmptyStateProps): ReactElement {
  return (
    <div
      data-slot="chart-empty-state"
      className="border-border/40 bg-muted/10 text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 text-center"
      style={{ height }}
    >
      <LineChartIcon
        className="text-muted-foreground/60 h-8 w-8"
        aria-hidden="true"
      />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="text-xs">{description}</p> : null}
    </div>
  );
}
