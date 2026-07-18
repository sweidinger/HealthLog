"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";

import { useTranslations } from "@/lib/i18n/context";

/**
 * Per-workout heart-rate curve. Rendered ONLY through the shared
 * `chart-runtime.ts` barrel (the one recharts async boundary) so the
 * library stays a single shared chunk — never import this file directly
 * at a call site.
 *
 * `ComposedChart`: an `Area` for the min→max envelope (drawn only when
 * the series is dense enough to be honest), a `Line` for the bucket
 * mean, optional %HRmax zone bands behind them, and a dashed reference
 * line at the workout's average HR. Gaps stay gaps (`connectNulls`
 * false) — a hole in the recording never reads as an interpolated
 * curve.
 */

export interface WorkoutHrChartPoint {
  tSec: number;
  mean: number;
  min: number;
  max: number;
}

export interface WorkoutHrZoneBand {
  zone: number;
  lowBpm: number | null;
  highBpm: number | null;
}

export interface WorkoutHrChartProps {
  points: WorkoutHrChartPoint[];
  bucketSec: number;
  /** Draw the min→max envelope band behind the mean line. */
  envelope: boolean;
  /** Workout average HR for the reference line. */
  avgHr: number | null;
  /** Optional %HRmax zone bands for the shaded background. */
  zones?: WorkoutHrZoneBand[] | null;
}

const ZONE_FILLS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function minuteTick(seconds: number): string {
  return String(Math.round(seconds / 60));
}

export function WorkoutHrChart({
  points,
  bucketSec,
  envelope,
  avgHr,
  zones,
}: WorkoutHrChartProps) {
  const { t } = useTranslations();

  // Build a full elapsed-time grid so a gap of missing buckets breaks
  // the line rather than interpolating across it.
  const data = useMemo(() => {
    if (points.length === 0) return [];
    const byT = new Map(points.map((p) => [p.tSec, p]));
    const maxT = points[points.length - 1].tSec;
    const grid: Array<{
      tSec: number;
      mean: number | null;
      lo: number | null;
      hi: number | null;
    }> = [];
    for (let tSec = 0; tSec <= maxT; tSec += bucketSec) {
      const p = byT.get(tSec);
      grid.push({
        tSec,
        mean: p ? p.mean : null,
        lo: p ? p.min : null,
        hi: p && envelope ? p.max - p.min : null,
      });
    }
    return grid;
  }, [points, bucketSec, envelope]);

  return (
    <div
      className="h-48 w-full touch-pan-y sm:h-64"
      data-slot="workout-hr-chart"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.5}
          />
          {zones?.map((z) =>
            z.lowBpm != null ? (
              <ReferenceArea
                key={z.zone}
                y1={z.lowBpm}
                y2={z.highBpm ?? undefined}
                fill={ZONE_FILLS[z.zone - 1]}
                fillOpacity={0.06}
                ifOverflow="hidden"
              />
            ) : null,
          )}
          <XAxis
            dataKey="tSec"
            type="number"
            domain={[0, "dataMax"]}
            tickFormatter={minuteTick}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            unit=""
          />
          <YAxis
            domain={["dataMin - 10", "dataMax + 10"]}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.875rem",
            }}
            labelFormatter={(tSec) =>
              `${minuteTick(Number(tSec))} ${t("insights.workouts.detail.hrAxisMinutes")}`
            }
            formatter={(value, name) =>
              name === "mean"
                ? [`${value} bpm`, t("insights.workouts.detail.hrChartTitle")]
                : [null, null]
            }
          />
          {/* Envelope band: a transparent base at `lo` plus a stacked
              `hi` (= max − min) renders the min→max ribbon. Only present
              when `envelope` gated it in. */}
          {envelope ? (
            <>
              <Area
                type="monotone"
                dataKey="lo"
                stackId="band"
                stroke="none"
                fill="transparent"
                connectNulls={false}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="hi"
                stackId="band"
                stroke="none"
                fill="var(--chart-1)"
                fillOpacity={0.15}
                connectNulls={false}
                isAnimationActive={false}
              />
            </>
          ) : null}
          {avgHr != null ? (
            <ReferenceLine
              y={avgHr}
              stroke="var(--muted-foreground)"
              strokeDasharray="5 5"
              strokeOpacity={0.7}
            />
          ) : null}
          <Line
            type="monotone"
            dataKey="mean"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
