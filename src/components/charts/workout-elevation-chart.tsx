"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { useTranslations } from "@/lib/i18n/context";

/**
 * Workout elevation profile — a small cumulative-distance / altitude
 * area under the route map. Rendered ONLY through `chart-runtime.ts`.
 * Present only when ≥ 60 % of route coordinates carry altitude (the
 * caller gates it); partial altimeter data would draw a lie.
 */

export interface WorkoutElevationPoint {
  distanceM: number;
  altitude: number;
}

export function WorkoutElevationChart({
  points,
}: {
  points: WorkoutElevationPoint[];
}) {
  const { t } = useTranslations();
  const data = points.map((p) => ({ km: p.distanceM / 1000, alt: p.altitude }));

  return (
    <div className="h-24 w-full" data-slot="workout-elevation-chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient
              id="workoutElevationFill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.4}
          />
          <XAxis
            dataKey="km"
            type="number"
            domain={[0, "dataMax"]}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickFormatter={(v) => Number(v).toFixed(1)}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={["dataMin - 5", "dataMax + 5"]}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={36}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.875rem",
            }}
            labelFormatter={(km) => `${Number(km).toFixed(2)} km`}
            formatter={(value) => [
              `${Math.round(Number(value))} m`,
              t("insights.workouts.detail.elevationTitle"),
            ]}
          />
          <Area
            type="monotone"
            dataKey="alt"
            stroke="var(--chart-2)"
            strokeWidth={2}
            fill="url(#workoutElevationFill)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
