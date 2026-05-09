"use client";

import type { ReactElement } from "react";

/**
 * Reusable Apple-Health-style linear gradient for area / line fills.
 *
 * Recharts ships an Area component that accepts a `fill="url(#id)"` prop
 * pointing at a `<linearGradient>` defined inside an SVG `<defs>` block.
 * v1.4.16 B1a paints a soft Dracula-token gradient under the line so the
 * chart reads like the Apple Health "Trends" cards: the metric colour at
 * the top of the area fades down to nearly transparent at the bottom.
 *
 * Why a wrapper component:
 *   1. The gradient lives in `<defs>` and must be sibling-rendered to
 *      `<Area fill="url(#id)" />`. Recharts allows arbitrary children in
 *      `LineChart` / `AreaChart` and renders them inside its `<svg>`, so
 *      a small named primitive keeps the call sites readable
 *      (`<ChartLinearGradient id="bp" colorVar="--dracula-purple" />`)
 *      instead of inlining 8 lines of `<defs><linearGradient>...` per
 *      chart.
 *   2. Tokens stay canonical — only the `colorVar` prop is exposed; the
 *      stop offsets / opacities are baked in to enforce a consistent
 *      look across all 5 charts (BP, weight, pulse, mood, medication).
 *   3. SSR safe — pure SVG, no DOM APIs touched. The unit test renders
 *      it via `renderToStaticMarkup`.
 *
 * Defaults follow the Apple Health pattern: ~35 % alpha at the top of
 * the area, 0 % at the bottom. The pinned stops also stay clear of the
 * grid lines so a domain like "60 .. 110 mmHg" still reads as a
 * gradient, not a flat colour wash.
 */

export interface ChartLinearGradientProps {
  /** SVG id used by Recharts: `<Area fill="url(#${id})" />`. */
  id: string;
  /**
   * CSS variable name (e.g. `--dracula-purple`). The component wraps it
   * in `var(...)` so callers can pass the token verbatim.
   */
  colorVar: string;
  /** Alpha at the top of the area. Defaults to 0.35. */
  topOpacity?: number;
  /** Alpha at the bottom of the area. Defaults to 0.0. */
  bottomOpacity?: number;
}

/**
 * Renders a `<defs><linearGradient .../></defs>` block.
 *
 * The gradient runs vertically (x1=0,x2=0,y1=0,y2=1) so it shades the
 * area top-down, matching how Apple Health paints the metric colour
 * over the chart background.
 */
export function ChartLinearGradient({
  id,
  colorVar,
  topOpacity = 0.35,
  bottomOpacity = 0,
}: ChartLinearGradientProps): ReactElement {
  const fill = `var(${colorVar})`;

  return (
    <defs>
      <linearGradient
        id={id}
        x1="0"
        y1="0"
        x2="0"
        y2="1"
        data-slot="chart-linear-gradient"
        data-color-var={colorVar}
      >
        <stop offset="0%" stopColor={fill} stopOpacity={topOpacity} />
        <stop offset="100%" stopColor={fill} stopOpacity={bottomOpacity} />
      </linearGradient>
    </defs>
  );
}

/**
 * Build the `fill` attribute string Recharts expects when wiring an
 * `<Area>` to a `<ChartLinearGradient id="x">` defined alongside.
 */
export function chartGradientFill(id: string): string {
  return `url(#${id})`;
}
