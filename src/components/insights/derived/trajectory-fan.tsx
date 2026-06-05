"use client";

import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";

/**
 * v1.12.1 — the Recharts fan band of the trajectory forecast card,
 * split into its own module so it can be `next/dynamic`-deferred.
 *
 * `TrajectoryForecastCard` is mounted by the shared `HealthKitMetricPage`
 * on every trajectory-eligible metric page; before this split it pulled
 * Recharts into the page's initial chunk eagerly (the main metric chart
 * is already deferred via `HealthChartDynamic`). Isolating the only
 * Recharts-touching subtree here lets the card chrome render without the
 * chart library and lazy-load this chunk only when there's a projection
 * to draw — keeping the chart visually identical (same ComposedChart /
 * Area / Line / ReferenceLine geometry, same `isAnimationActive={false}`).
 */

export interface TrajectoryFanPoint {
  date: string;
  projected: number;
  /** Stacked transparent base (= bandLow). */
  base: number;
  /** Shaded band height (= bandHigh − bandLow). */
  range: number;
}

export function TrajectoryFan({
  points,
  color,
}: {
  points: TrajectoryFanPoint[];
  color: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart
        data={points}
        margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
      >
        <XAxis dataKey="date" hide />
        <YAxis domain={["auto", "auto"]} hide />
        <Area
          dataKey="base"
          stackId="band"
          stroke="none"
          fill="none"
          isAnimationActive={false}
        />
        <Area
          dataKey="range"
          stackId="band"
          stroke="none"
          fill={color}
          fillOpacity={0.15}
          isAnimationActive={false}
        />
        <Line
          dataKey="projected"
          type="monotone"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="4 3"
          dot={false}
          isAnimationActive={false}
        />
        <ReferenceLine x="now" stroke="var(--border)" strokeDasharray="2 2" />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
