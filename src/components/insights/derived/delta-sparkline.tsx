"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

/**
 * The recharts body of the `<SparklineDeltaTile>` inline sparkline,
 * extracted so the tile itself carries no static recharts import. The tile
 * loads this through the shared chart-runtime boundary
 * (`@/components/charts/chart-runtime`); its fixed 40 px container is owned
 * by the tile, so the async gap paints an empty band of identical size —
 * zero layout shift, pixel-identical once mounted.
 */
export function DeltaSparkline({
  data,
  strokeVar,
}: {
  /** `{ i, v }` points, already length-guarded (≥2) by the tile. */
  data: Array<{ i: number; v: number }>;
  /** CSS var expression for the sentiment stroke, e.g. `var(--success)`. */
  strokeVar: string;
}) {
  // A stable per-instance id for the gradient <defs>. Deriving it from a
  // label slug collides when two tiles share a localized label (the gradient
  // fill on the second tile would not resolve); useId() is collision-free.
  const fillId = useId();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
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
  );
}
